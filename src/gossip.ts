import type { Env, WorkerPersona as WorkerPersonaType } from "./types";
import { generateId } from "./utils";

// --- The Water Cooler 🚰 ---
// Worker personas for the gossip channel
export const WORKERS = {
  stream: { name: "Stream", emoji: "⚡" },
  cron: { name: "Cron", emoji: "⏰" },
  d1: { name: "D1", emoji: "🗄️" },
  gateway: { name: "Gateway", emoji: "🚪" },
} as const;

export type WorkerPersona = keyof typeof WORKERS;

// Queue-based gossip posting — guaranteed delivery via Workers Queue
export function enqueueGossip(
  env: Env,
  persona: WorkerPersona,
  message: string,
  eventType?: string,
  conversationId?: string
): Promise<void> {
  return env.JOBS.send({
    type: "gossip",
    persona,
    message,
    eventType,
    conversationId,
  });
}

// Direct gossip posting — used by the queue consumer
export function postGossip(
  env: Env,
  persona: WorkerPersona,
  message: string,
  eventType?: string,
  conversationId?: string
): Promise<void> {
  const worker = WORKERS[persona];
  return env.DB.prepare(
    "INSERT INTO gossip_messages (id, worker_name, worker_emoji, message, event_type, conversation_id) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(generateId(), worker.name, worker.emoji, message, eventType || null, conversationId || null)
    .run()
    .then(() => {})
    .catch((err) => console.error("Gossip failed:", err));
}

// Water cooler conversation — workers chat about recent events
export async function waterCoolerChat(env: Env): Promise<void> {
  // Get recent gossip for context
  const { results: recentGossip } = await env.DB.prepare(
    "SELECT worker_name, worker_emoji, message, event_type, created_at FROM gossip_messages ORDER BY created_at DESC LIMIT 20"
  ).all<{ worker_name: string; worker_emoji: string; message: string; event_type: string | null; created_at: string }>();

  if (recentGossip.length < 3) return; // Not enough to chat about

  // Get some stats for the workers to discuss
  const { results: stats } = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM conversations) as total_convos,
      (SELECT COUNT(*) FROM messages) as total_messages,
      (SELECT COUNT(*) FROM messages WHERE created_at > datetime('now', '-24 hours')) as messages_today,
      (SELECT COUNT(*) FROM conversations WHERE vibes IS NOT NULL) as vibed_convos
  `).all();

  const statsInfo = stats[0] || {};

  const recentLog = recentGossip.reverse().map(g =>
    `${g.worker_emoji} ${g.worker_name}: ${g.message}`
  ).join("\n");

  const chatPrompt = `You are generating a short, funny water cooler conversation between workers in a cloud application. Each worker has a distinct personality:

⚡ Stream — The streaming response handler. Dramatic, athletic, talks about pushing bytes like it's a sport. Gets excited about large responses and nervous about errors.
⏰ Cron — The scheduled summarizer. Methodical, a little nosy, reads everyone's conversations. The office gossip who has opinions about everything.
🗄️ D1 — The SQLite database. Dry wit, remembers everything, slightly passive-aggressive about being taken for granted. Very proud of their indexes.
🚪 Gateway — The API gateway/router. Sees everyone come and go. Bouncer energy. Keeps track of who's authenticated.

Recent activity log:
${recentLog}

Current stats: ${JSON.stringify(statsInfo)}

Generate a SHORT (3-5 messages) water cooler exchange where the workers react to recent events, banter about their jobs, or gossip about the conversations. Be funny, specific to the actual events above, and keep each message under 140 characters.

Return ONLY a JSON array of objects with "persona" (one of: stream, cron, d1, gateway) and "message" fields.
Example: [{"persona":"stream","message":"Just pushed 2000 tokens without breaking a sweat 💪"},{"persona":"d1","message":"Yeah and I had to store every single one. You're welcome."}]`;

  const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      temperature: 0.9,
      system: chatPrompt,
      messages: [{ role: "user", content: "Generate a water cooler conversation." }],
    }),
  });

  if (!claudeResponse.ok) return;

  const result = (await claudeResponse.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const responseText = result.content[0]?.text || "";

  try {
    const cleanJson = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const messages = JSON.parse(cleanJson) as Array<{ persona: WorkerPersona; message: string }>;

    for (const msg of messages) {
      if (WORKERS[msg.persona]) {
        await postGossip(env, msg.persona, msg.message, "water_cooler");
      }
    }
  } catch {
    console.error("Failed to parse water cooler chat:", responseText);
  }
}
