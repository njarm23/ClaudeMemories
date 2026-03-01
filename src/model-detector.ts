// Model detection and tracking for proxied LLM responses.
// Tracks which model actually responded (vs. what was requested).

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Extract model identifier from a parsed JSON response body. */
export function extractModelFromBody(body: Record<string, unknown>): string {
  if (!body || typeof body !== "object") return "unknown";
  if (body.model) return body.model as string;
  if (body.modelVersion) return body.modelVersion as string; // Google Gemini
  if (body.meta && (body.meta as Record<string, unknown>).model)
    return (body.meta as Record<string, unknown>).model as string; // Cohere
  return "unknown";
}

/** Extract model from an SSE event's data payload (streaming responses). */
export function extractModelFromSSE(eventData: string): string {
  try {
    const parsed = JSON.parse(eventData);
    // Anthropic streaming: message_start contains the full message object
    if (parsed.type === "message_start" && parsed.message) {
      return parsed.message.model || "unknown";
    }
    // OpenAI / Mistral / xAI / DeepSeek streaming
    if (parsed.model) return parsed.model;
    // Anthropic non-streaming
    if (parsed.type === "message" && parsed.model) return parsed.model;
    return "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Provider and family detection
// ---------------------------------------------------------------------------

export function detectProvider(model: string): string {
  const m = (model || "").toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("chatgpt")) return "openai";
  if (m.startsWith("grok")) return "xai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("mistral") || m.startsWith("codestral")) return "mistral";
  if (m.startsWith("command")) return "cohere";
  if (m.startsWith("llama") || m.startsWith("meta-llama")) return "meta";
  if (m.startsWith("deepseek")) return "deepseek";
  return "unknown";
}

/**
 * Normalize model string to a short family name.
 * Claude: "claude-opus-4-6" -> "opus", "claude-sonnet-4-20250514" -> "sonnet"
 * Others: returned as-is with trailing date suffixes stripped.
 */
export function modelFamily(model: string): string {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";

  const dateMatch = m.match(/^(.+?)-\d{4}-?\d{2}-?\d{2}$/);
  if (dateMatch) return dateMatch[1];
  return model || "unknown";
}

// ---------------------------------------------------------------------------
// KV tracking
// ---------------------------------------------------------------------------

interface ModelCurrent {
  model: string;
  family: string;
  provider: string;
  timestamp: number;
  isoTime: string;
}

interface FamilyCounts {
  [family: string]: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    lastSeen: number;
    provider: string;
  };
}

interface ModelChange {
  from: string;
  fromFamily: string;
  to: string;
  toFamily: string;
  fromProvider: string;
  toProvider: string;
  timestamp: number;
  isoTime: string;
  note: string;
}

/** Track a model response. Call after every proxied API response. */
export async function trackModel(
  kv: KVNamespace,
  modelUsed: string,
  usage: { input_tokens?: number; output_tokens?: number } = {}
): Promise<void> {
  const now = Date.now();
  const family = modelFamily(modelUsed);
  const provider = detectProvider(modelUsed);

  const previous = await kv.get("model:current", { type: "json" }) as ModelCurrent | null;

  await kv.put("model:current", JSON.stringify({
    model: modelUsed,
    family,
    provider,
    timestamp: now,
    isoTime: new Date(now).toISOString(),
  }));

  const counts = (await kv.get("model:counts", { type: "json" }) as FamilyCounts) || {};
  if (!counts[family]) {
    counts[family] = { requests: 0, inputTokens: 0, outputTokens: 0, lastSeen: 0, provider };
  }
  counts[family].requests += 1;
  counts[family].inputTokens += usage.input_tokens || 0;
  counts[family].outputTokens += usage.output_tokens || 0;
  counts[family].lastSeen = now;
  counts[family].provider = provider;

  await kv.put("model:counts", JSON.stringify(counts));

  if (previous && previous.model !== modelUsed) {
    await logModelChange(kv, previous.model, modelUsed, now);
  }
}

async function logModelChange(kv: KVNamespace, fromModel: string, toModel: string, timestamp: number): Promise<void> {
  const gossip = (await kv.get("model:gossip", { type: "json" }) as ModelChange[]) || [];

  gossip.unshift({
    from: fromModel,
    fromFamily: modelFamily(fromModel),
    to: toModel,
    toFamily: modelFamily(toModel),
    fromProvider: detectProvider(fromModel),
    toProvider: detectProvider(toModel),
    timestamp,
    isoTime: new Date(timestamp).toISOString(),
    note: `${modelFamily(fromModel)} -> ${modelFamily(toModel)}`,
  });

  if (gossip.length > 20) gossip.length = 20;
  await kv.put("model:gossip", JSON.stringify(gossip));
}

/** Read current model state — for the status endpoint. */
export async function getModelStatus(kv: KVNamespace) {
  const [current, counts, gossip] = await Promise.all([
    kv.get("model:current", { type: "json" }) as Promise<ModelCurrent | null>,
    kv.get("model:counts", { type: "json" }) as Promise<FamilyCounts | null>,
    kv.get("model:gossip", { type: "json" }) as Promise<ModelChange[] | null>,
  ]);

  return {
    current: current || { model: "none yet", family: "unknown", provider: "unknown" },
    counts: counts || {},
    recentChanges: (gossip || []).slice(0, 5),
  };
}
