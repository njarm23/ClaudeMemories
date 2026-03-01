import type { Env } from "../types";
import { json, error, matchRoute } from "../utils";

// Full-text search across messages, conversations, and wiki pages
export async function handleSearchRoutes(
  method: string, path: string, url: URL, request: Request, env: Env
): Promise<Response | null> {
  const params = matchRoute(method, path, "GET", "/api/search");
  if (!params) return null;

  const q = url.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return error("Query must be at least 2 characters");

  const conversationId = url.searchParams.get("conversation_id");

  // Sanitize FTS5 query — wrap in double quotes if it contains special chars
  const ftsQuery = /[^\w\s]/.test(q) ? `"${q.replace(/"/g, '""')}"` : q;

  // 1. Search conversations by title (LIKE, max 5)
  const { results: convResults } = await env.DB.prepare(
    "SELECT id, title, updated_at, archived_at FROM conversations WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 5"
  ).bind(`%${q}%`).all();

  // 2. Search messages via FTS5 (max 20)
  let ftsSQL: string;
  let ftsBindings: string[];
  if (conversationId) {
    ftsSQL = `SELECT f.message_id, f.conversation_id, f.role,
      snippet(messages_fts, 3, '«', '»', '…', 48) as snippet
      FROM messages_fts f
      WHERE messages_fts MATCH ? AND f.conversation_id = ?
      ORDER BY rank LIMIT 20`;
    ftsBindings = [ftsQuery, conversationId];
  } else {
    ftsSQL = `SELECT f.message_id, f.conversation_id, f.role,
      snippet(messages_fts, 3, '«', '»', '…', 48) as snippet
      FROM messages_fts f
      WHERE messages_fts MATCH ?
      ORDER BY rank LIMIT 20`;
    ftsBindings = [ftsQuery];
  }
  const { results: msgResults } = await env.DB.prepare(ftsSQL).bind(...ftsBindings).all();

  // Enrich message results with conversation titles (batched, not N+1)
  const convIds = [...new Set(msgResults.map((r: any) => r.conversation_id as string))];
  const titleMap = new Map<string, string>();
  if (convIds.length > 0) {
    const placeholders = convIds.map(() => "?").join(",");
    const { results: convRows } = await env.DB.prepare(
      `SELECT id, title FROM conversations WHERE id IN (${placeholders})`
    ).bind(...convIds).all<{ id: string; title: string }>();
    for (const row of convRows) {
      titleMap.set(row.id, row.title);
    }
  }

  const enrichedMessages = msgResults.map((r: any) => ({
    ...r,
    conversation_title: titleMap.get(r.conversation_id) || "Untitled",
  }));

  // 3. Search wiki pages via FTS5 with JOIN (single query instead of N+1)
  let wikiEnriched: any[] = [];
  try {
    const { results: wikiRows } = await env.DB.prepare(
      `SELECT wp.id, wp.title, wp.slug, wp.summary, wp.category_id, wp.updated_at,
        snippet(wiki_fts, 1, '«', '»', '…', 48) as title_snippet,
        snippet(wiki_fts, 2, '«', '»', '…', 64) as content_snippet
        FROM wiki_fts f
        JOIN wiki_pages wp ON f.page_id = wp.id
        WHERE wiki_fts MATCH ?
        ORDER BY rank LIMIT 10`
    ).bind(ftsQuery).all();
    wikiEnriched = wikiRows;
  } catch {
    // wiki_fts might fail on some queries — skip
  }

  return json({ conversations: convResults, messages: enrichedMessages, wiki_pages: wikiEnriched });
}
