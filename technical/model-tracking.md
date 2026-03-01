# Model Tracking Reference

**Last updated:** March 1, 2026
**Status:** Reference for proxy worker model detection

---

## What This Does

Reads which model (Claude, GPT, Grok, Gemini, etc.) is responding to API
requests proxied through the Cloudflare Worker. Tracks usage in KV and logs
when the model changes between requests.

Works with any LLM provider. Tested against Anthropic and OpenAI response
formats. Should work with any provider that returns a model field in the
response body (which is nearly all of them).

---

## Important: Where the Model Lives

The model identifier is NOT in the response headers.
It is in the response body JSON.

**Anthropic:**

    { "model": "claude-opus-4-6", "usage": { ... }, ... }

**OpenAI / xAI (Grok) / Mistral / DeepSeek:**

    { "model": "gpt-4o-2024-08-06", "usage": { ... }, ... }

**Google Gemini:**

    { "modelVersion": "gemini-1.5-pro", ... }

**Cohere:**

    { "meta": { "model": "command-r-plus" }, ... }

The x-anthropic-model header does not exist.
The cf-meta-model header does not exist.
Parse the response body. That is the only reliable source.

### Streaming

For streaming responses, the model appears in the first SSE event.

**Anthropic streaming:**

    event: message_start
    data: {"type":"message_start","message":{"model":"claude-opus-4-6",...}}

**OpenAI / xAI / Mistral streaming:**

    data: {"model":"gpt-4o","choices":[...],...}

In both cases the model field is in the first data payload.
See the streaming integration pattern in model-detector.js.

---

## Provider Detection

The detector infers the provider from the model string:

    claude-*                  -> anthropic
    gpt-*, o1-*, o3-*, o4-*  -> openai
    grok-*                    -> xai
    gemini-*                  -> google
    mistral-*, codestral-*    -> mistral
    command-*                 -> cohere
    llama-*, meta-llama*      -> meta
    deepseek-*                -> deepseek
    anything else             -> unknown

Claude models get family names (opus, sonnet, haiku).
Non-Claude models use the string as-is (gpt-4o, grok-3, etc.).

---

## KV Namespace Setup

1. Go to Cloudflare dashboard -> Workers & Pages -> KV
2. Create a new namespace called MODEL_TRACKING
3. Go to your proxy worker -> Settings -> Bindings
4. Add KV Namespace binding:
   - Variable name: MODEL_KV
   - KV namespace: MODEL_TRACKING

---

## KV Schema

Three keys. That is it.

### model:current

Last model that responded. Updated on every request.

    {
      "model": "claude-opus-4-6",
      "family": "opus",
      "provider": "anthropic",
      "timestamp": 1709312400000,
      "isoTime": "2026-03-01T18:00:00.000Z"
    }

### model:counts

Cumulative usage by model family. Updated on every request.

    {
      "opus": {
        "requests": 42,
        "inputTokens": 85000,
        "outputTokens": 32000,
        "lastSeen": 1709312400000,
        "provider": "anthropic"
      },
      "gpt-4o": {
        "requests": 15,
        "inputTokens": 30000,
        "outputTokens": 12000,
        "lastSeen": 1709308800000,
        "provider": "openai"
      },
      "grok-3": {
        "requests": 5,
        "inputTokens": 10000,
        "outputTokens": 4000,
        "lastSeen": 1709305200000,
        "provider": "xai"
      }
    }

### model:gossip

Rolling log of the last 20 model changes. Newest first.

    [
      {
        "from": "gpt-4o",
        "fromFamily": "gpt-4o",
        "to": "claude-opus-4-6",
        "toFamily": "opus",
        "fromProvider": "openai",
        "toProvider": "anthropic",
        "timestamp": 1709312400000,
        "isoTime": "2026-03-01T18:00:00.000Z",
        "note": "gpt-4o -> opus"
      }
    ]

---

## Integration

Copy the functions from technical/worker/model-detector.js into your
proxy worker in the Cloudflare dashboard.

In your fetch handler, after getting the API response:

    const body = await response.json();
    const modelUsed = extractModelFromBody(body);

    ctx.waitUntil(trackModel(env.MODEL_KV, modelUsed, body.usage));

    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: response.headers
    });

Use ctx.waitUntil() so tracking does not block the response.

For streaming, see the streaming integration pattern in model-detector.js.

---

## Reading the Data

From a worker or API:

    const status = await getModelStatus(env.MODEL_KV);
    return Response.json(status);

From KV dashboard:
    Go to Workers & Pages -> KV -> MODEL_TRACKING
    Click on model:current, model:counts, or model:gossip

---

## KV Write Costs

Every proxied request writes to model:current and model:counts (2 writes).
KV free tier allows 1,000 writes/day -- that is 500 requests/day.

If you need more:
- Only write model:current when the model actually changes (saves 1 write)
- Accept the paid tier ($0.50 per million writes)

The implementation writes on every request for simplicity. Optimize later
if the volume warrants it.

---

## Future Extensions (not built yet)

- Webhook notification on model change (post to claude-memory worker)
- Daily/weekly usage summaries written to the garden
- Rate of model switching as a signal
- Token cost estimation per model family
- Expose a /status endpoint on the proxy worker
- Provider-specific cost tracking

Do not build these until there is a reason to.

---

## Debugging

If model shows as "unknown":
-- Check that you are reading the response body, not headers
-- Check that streaming extraction is catching the first data event
-- Log the raw response body to verify structure
-- If using a new provider, check what field name they use for model

If KV is not updating:
-- Check that MODEL_KV binding exists in worker settings
-- Check that ctx.waitUntil() is being used (not just await in fetch)
-- Check Cloudflare dashboard -> Workers -> Logs for errors

If provider shows as "unknown":
-- The model string prefix is not in the detection table
-- Add it to detectProvider() in model-detector.js

---

Built March 1, 2026. Corrected header assumption -- the model is in the body.
Multi-provider support added same day after realizing the proxy routes to
more than just Anthropic.
