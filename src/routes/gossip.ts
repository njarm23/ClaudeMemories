import type { Env } from "../types";
import { json, matchRoute } from "../utils";
import { waterCoolerChat } from "../gossip";
import { generateSummariesWithLog } from "../summarize";

// Gossip feed + water cooler trigger + manual summarization trigger
export async function handleGossipRoutes(
  method: string, path: string, url: URL, request: Request, env: Env
): Promise<Response | null> {
  let params;

  // --- Gossip: Read the feed ---
  params = matchRoute(method, path, "GET", "/api/gossip");
  if (params) {
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const { results } = await env.DB.prepare(
      "SELECT * FROM gossip_messages ORDER BY created_at DESC LIMIT ?"
    )
      .bind(Math.min(limit, 100))
      .all();
    return json(results.reverse()); // Return in chronological order
  }

  // --- Gossip: Trigger water cooler chat ---
  params = matchRoute(method, path, "POST", "/api/gossip/water-cooler");
  if (params) {
    try {
      await waterCoolerChat(env);
      return json({ ok: true, message: "Water cooler chat triggered!" });
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // --- Summaries: Trigger manually ---
  params = matchRoute(method, path, "POST", "/api/summarize");
  if (params) {
    try {
      const results = await generateSummariesWithLog(env);
      return json({ ok: true, message: "Summarization complete", results });
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  return null; // No route matched
}
