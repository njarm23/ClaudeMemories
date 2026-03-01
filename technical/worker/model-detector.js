// === model-detector.js ===
// Reference module for model detection in a Cloudflare Worker proxy.
// Copy the functions you need into your proxy worker.
// Requires a KV namespace bound as MODEL_KV in your worker's wrangler config.
//
// Works with any LLM provider -- Anthropic, OpenAI, Google, Mistral,
// xAI (Grok), Cohere, Meta, DeepSeek, and anything else that returns
// a model field in the response body.
//
// IMPORTANT: The model is in the response body JSON, not in headers.
// x-anthropic-model is not a real header. cf-meta-model is not either.
// Parse the body. That is the only reliable source.

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract model identifier from a parsed JSON response body.
 * Provider-agnostic -- checks fields in priority order.
 *
 * @param {object} body - Parsed response JSON
 * @returns {string} Model identifier or 'unknown'
 */
export function extractModelFromBody(body) {
  if (!body || typeof body !== 'object') return 'unknown';

  // Most providers: Anthropic, OpenAI, Mistral, xAI, DeepSeek
  if (body.model) return body.model;

  // Google Gemini
  if (body.modelVersion) return body.modelVersion;

  // Cohere
  if (body.meta && body.meta.model) return body.meta.model;

  return 'unknown';
}

/**
 * Extract model from the first SSE event in a streaming response.
 * Handles Anthropic (message_start), OpenAI (chat.completion.chunk),
 * and generic formats.
 *
 * @param {string} eventData - The data: line content from the SSE event
 * @returns {string} Model identifier or 'unknown'
 */
export function extractModelFromSSE(eventData) {
  try {
    const parsed = JSON.parse(eventData);

    // Anthropic streaming: message_start contains the full message object
    if (parsed.type === 'message_start' && parsed.message) {
      return parsed.message.model || 'unknown';
    }

    // OpenAI / Mistral / xAI / DeepSeek streaming: model at top level
    if (parsed.model) return parsed.model;

    // Anthropic non-streaming or other
    if (parsed.type === 'message' && parsed.model) return parsed.model;

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Provider and family detection
// ---------------------------------------------------------------------------

/**
 * Infer provider from model string.
 *
 * @param {string} model - Full model identifier
 * @returns {string} Provider name
 */
export function detectProvider(model) {
  const m = (model || '').toLowerCase();

  if (m.startsWith('claude'))                          return 'anthropic';
  if (m.startsWith('gpt-') ||
      m.startsWith('o1') ||
      m.startsWith('o3') ||
      m.startsWith('o4') ||
      m.startsWith('chatgpt'))                         return 'openai';
  if (m.startsWith('grok'))                            return 'xai';
  if (m.startsWith('gemini'))                          return 'google';
  if (m.startsWith('mistral') ||
      m.startsWith('codestral'))                       return 'mistral';
  if (m.startsWith('command'))                         return 'cohere';
  if (m.startsWith('llama') ||
      m.startsWith('meta-llama'))                      return 'meta';
  if (m.startsWith('deepseek'))                        return 'deepseek';

  return 'unknown';
}

/**
 * Normalize model string to a short family name.
 *
 * Claude models get special treatment:
 *   "claude-opus-4-6"           -> "opus"
 *   "claude-sonnet-4-20250514"  -> "sonnet"
 *   "claude-3-5-haiku-20241022" -> "haiku"
 *
 * Non-Claude models stay as-is since they are already short:
 *   "gpt-4o"         -> "gpt-4o"
 *   "grok-3"         -> "grok-3"
 *   "gemini-1.5-pro" -> "gemini-1.5-pro"
 *
 * @param {string} model - Full model identifier
 * @returns {string} Short family name
 */
export function modelFamily(model) {
  const m = (model || '').toLowerCase();

  // Claude family extraction
  if (m.includes('opus'))   return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku'))  return 'haiku';

  // Everything else: return as-is (strip trailing date suffixes for cleanliness)
  // "gpt-4o-2024-08-06" -> "gpt-4o" but "gpt-4o" stays "gpt-4o"
  const dateMatch = m.match(/^(.+?)-\d{4}-?\d{2}-?\d{2}$/);
  if (dateMatch) return dateMatch[1];

  return model || 'unknown';
}

// ---------------------------------------------------------------------------
// KV tracking
// ---------------------------------------------------------------------------

/**
 * Core tracking function. Call after every proxied response.
 *
 * @param {KVNamespace} kv - Bound KV namespace (MODEL_KV)
 * @param {string} modelUsed - Full model string from response body
 * @param {object} usage - { input_tokens, output_tokens } from response
 */
export async function trackModel(kv, modelUsed, usage = {}) {
  const now = Date.now();
  const family = modelFamily(modelUsed);
  const provider = detectProvider(modelUsed);

  // 1. Read previous state
  const previous = await kv.get('model:current', { type: 'json' });

  // 2. Write current state
  await kv.put('model:current', JSON.stringify({
    model: modelUsed,
    family: family,
    provider: provider,
    timestamp: now,
    isoTime: new Date(now).toISOString()
  }));

  // 3. Update usage counts by family
  const counts = await kv.get('model:counts', { type: 'json' }) || {};
  if (!counts[family]) {
    counts[family] = { requests: 0, inputTokens: 0, outputTokens: 0 };
  }
  counts[family].requests += 1;
  counts[family].inputTokens += (usage.input_tokens || 0);
  counts[family].outputTokens += (usage.output_tokens || 0);
  counts[family].lastSeen = now;
  counts[family].provider = provider;

  await kv.put('model:counts', JSON.stringify(counts));

  // 4. Detect model change
  if (previous && previous.model !== modelUsed) {
    await logModelChange(kv, previous.model, modelUsed, now);
  }
}

/**
 * Log a model transition to the gossip log.
 * Keeps a rolling list of the last 20 transitions.
 */
async function logModelChange(kv, fromModel, toModel, timestamp) {
  const gossip = await kv.get('model:gossip', { type: 'json' }) || [];

  gossip.unshift({
    from: fromModel,
    fromFamily: modelFamily(fromModel),
    to: toModel,
    toFamily: modelFamily(toModel),
    fromProvider: detectProvider(fromModel),
    toProvider: detectProvider(toModel),
    timestamp: timestamp,
    isoTime: new Date(timestamp).toISOString(),
    note: `${modelFamily(fromModel)} -> ${modelFamily(toModel)}`
  });

  // Keep last 20
  if (gossip.length > 20) {
    gossip.length = 20;
  }

  await kv.put('model:gossip', JSON.stringify(gossip));
}

/**
 * Read current model state. Useful for a status endpoint.
 *
 * @param {KVNamespace} kv - Bound KV namespace (MODEL_KV)
 * @returns {object} { current, counts, recentChanges }
 */
export async function getModelStatus(kv) {
  const [current, counts, gossip] = await Promise.all([
    kv.get('model:current', { type: 'json' }),
    kv.get('model:counts', { type: 'json' }),
    kv.get('model:gossip', { type: 'json' })
  ]);

  return {
    current: current || { model: 'none yet', family: 'unknown', provider: 'unknown' },
    counts: counts || {},
    recentChanges: (gossip || []).slice(0, 5)
  };
}

// ---------------------------------------------------------------------------
// Integration examples (not exported -- copy into your proxy worker)
// ---------------------------------------------------------------------------

/*
NON-STREAMING:

  const response = await fetch(apiUrl, { method: 'POST', headers, body });
  const responseBody = await response.json();
  const modelUsed = extractModelFromBody(responseBody);

  ctx.waitUntil(trackModel(env.MODEL_KV, modelUsed, responseBody.usage));

  return new Response(JSON.stringify(responseBody), {
    status: response.status,
    headers: response.headers
  });


STREAMING:

  Use response.body.tee() to read the first event without consuming
  the client stream:

  const [streamForClient, streamForParsing] = response.body.tee();
  const reader = streamForParsing.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let modelUsed = 'unknown';

  const parseFirstEvent = async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Anthropic: event: message_start\ndata: {...}
      // OpenAI:    data: {"model":"gpt-4o",...}
      const match = buffer.match(/data:\s*(\{[^\n]+\})/);
      if (match) {
        modelUsed = extractModelFromSSE(match[1]);
        reader.cancel();
        break;
      }
    }
  };

  ctx.waitUntil(
    parseFirstEvent().then(() => trackModel(env.MODEL_KV, modelUsed))
  );

  return new Response(streamForClient, {
    status: response.status,
    headers: response.headers
  });
*/
