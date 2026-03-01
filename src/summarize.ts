import type { Env } from "./types";
import { postGossip } from "./gossip";

// --- Auto-summarization with vibe tagging ---

export async function summarizeConversation(env: Env, conversationId: string): Promise<void> {
  const { results: messages } = await env.DB.prepare(
    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 50"
  )
    .bind(conversationId)
    .all<{ role: string; content: string }>();

  if (messages.length < 4) return;

  // Truncate long messages to save tokens
  const truncatedMessages = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content,
  }));

  const summaryPrompt = `Analyze this conversation and return a JSON object with exactly two fields:
1. "summary": A concise 1-2 sentence summary of what was discussed and accomplished.
2. "vibes": An array of 1-4 vibe tags that describe the conversational energy. Choose from: playful, serious, technical, philosophical, creative, adorable, nerdy, focused, casual, witty, warm, chaotic, chill, intense, curious, supportive, sarcastic, wholesome, brainstormy, deep.

Return ONLY valid JSON, no markdown formatting, no explanation.
Example: {"summary":"Debugged a React rendering issue and refactored the component hierarchy.","vibes":["technical","focused","nerdy"]}`;

  const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      temperature: 0.3,
      system: summaryPrompt,
      messages: truncatedMessages,
    }),
  });

  if (!claudeResponse.ok) {
    const errText = await claudeResponse.text();
    let errDetail = "";
    try {
      const errJson = JSON.parse(errText);
      errDetail = `${errJson.error?.type}: ${errJson.error?.message}`;
    } catch {
      errDetail = errText.slice(0, 500);
    }
    throw new Error(`Claude API ${claudeResponse.status}: ${errDetail}`);
  }

  const result = (await claudeResponse.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const responseText = result.content[0]?.text || "";

  let parsed: { summary: string; vibes: string[] };
  try {
    const cleanJson = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    parsed = JSON.parse(cleanJson);
  } catch {
    console.error(`Failed to parse summary JSON for ${conversationId}:`, responseText);
    return;
  }

  if (!parsed.summary || !Array.isArray(parsed.vibes)) {
    console.error(`Invalid summary structure for ${conversationId}`);
    return;
  }

  await env.DB.prepare(
    "UPDATE conversations SET summary = ?, vibes = ?, last_summarized_at = datetime('now') WHERE id = ?"
  )
    .bind(parsed.summary, JSON.stringify(parsed.vibes), conversationId)
    .run();

  // 🚰 Gossip: vibes tagged
  const vibeStr = parsed.vibes.join(", ");
  await postGossip(env, "cron", `Just finished reading a conversation and tagged it [${vibeStr}]. ${parsed.vibes.includes("chaotic") ? "What a wild ride 🎢" : parsed.vibes.includes("wholesome") ? "My heart 🥺" : "Interesting combo 🤔"}`, "vibes_tagged", conversationId);
}

export async function generateSummaries(env: Env): Promise<void> {
  const { results: conversations } = await env.DB.prepare(`
    SELECT c.id FROM conversations c
    WHERE EXISTS (
      SELECT 1 FROM messages m
      WHERE m.conversation_id = c.id
      AND (c.last_summarized_at IS NULL OR m.created_at > c.last_summarized_at)
    )
    AND (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) >= 4
    LIMIT 20
  `).all<{ id: string }>();

  for (const conv of conversations) {
    try {
      await summarizeConversation(env, conv.id);
    } catch (err) {
      console.error(`Failed to summarize conversation ${conv.id}:`, err);
    }
  }
}

export async function generateSummariesWithLog(env: Env): Promise<Array<{ id: string; status: string; detail?: string }>> {
  const { results: conversations } = await env.DB.prepare(`
    SELECT c.id, c.title FROM conversations c
    WHERE EXISTS (
      SELECT 1 FROM messages m
      WHERE m.conversation_id = c.id
      AND (c.last_summarized_at IS NULL OR m.created_at > c.last_summarized_at)
    )
    AND (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) >= 4
    LIMIT 20
  `).all<{ id: string; title: string }>();

  const results: Array<{ id: string; status: string; detail?: string }> = [];

  for (const conv of conversations) {
    try {
      await summarizeConversation(env, conv.id);
      results.push({ id: conv.id, status: "ok" });
    } catch (err) {
      results.push({
        id: conv.id,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
