import type { Env } from "../types";
import { generateId, json, error, matchRoute } from "../utils";

// Tags CRUD + conversation-tag assignment + annotations CRUD
export async function handleTagRoutes(
  method: string, path: string, url: URL, request: Request, env: Env
): Promise<Response | null> {
  let params;

  // --- Tags: List (with conversation counts) ---
  params = matchRoute(method, path, "GET", "/api/tags");
  if (params) {
    const { results } = await env.DB.prepare(
      `SELECT t.*, COUNT(ct.conversation_id) as conversation_count
       FROM tags t LEFT JOIN conversation_tags ct ON t.id = ct.tag_id
       GROUP BY t.id ORDER BY t.name`
    ).all();
    return json(results);
  }

  // --- Tags: Create ---
  params = matchRoute(method, path, "POST", "/api/tags");
  if (params) {
    const body = (await request.json()) as { name: string; color?: string };
    if (!body.name || !body.name.trim()) return error("Tag name is required");

    const name = body.name.trim().toLowerCase();
    const color = body.color || null;

    // Check for duplicate
    const existing = await env.DB.prepare("SELECT id FROM tags WHERE name = ?").bind(name).first();
    if (existing) return error("Tag already exists", 409);

    const id = generateId();
    await env.DB.prepare("INSERT INTO tags (id, name, color) VALUES (?, ?, ?)")
      .bind(id, name, color)
      .run();

    return json({ id, name, color }, 201);
  }

  // --- Tags: Delete ---
  params = matchRoute(method, path, "DELETE", "/api/tags/:id");
  if (params) {
    await env.DB.prepare("DELETE FROM tags WHERE id = ?").bind(params.id).run();
    return json({ ok: true });
  }

  // --- Conversation Tags: Add ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/tags");
  if (params) {
    const body = (await request.json()) as { tag_id?: string; name?: string; color?: string };
    const conversationId = params.id;

    let tagId = body.tag_id;

    // Auto-create tag if name provided instead of id
    if (!tagId && body.name) {
      const name = body.name.trim().toLowerCase();
      const existing = await env.DB.prepare("SELECT id FROM tags WHERE name = ?").bind(name).first<{ id: string }>();
      if (existing) {
        tagId = existing.id;
      } else {
        tagId = generateId();
        await env.DB.prepare("INSERT INTO tags (id, name, color) VALUES (?, ?, ?)")
          .bind(tagId, name, body.color || null)
          .run();
      }
    }

    if (!tagId) return error("Either tag_id or name is required");

    // Upsert — ignore if already assigned
    await env.DB.prepare(
      "INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)"
    ).bind(conversationId, tagId).run();

    // Return the full tag
    const tag = await env.DB.prepare("SELECT * FROM tags WHERE id = ?").bind(tagId).first();
    return json(tag, 201);
  }

  // --- Conversation Tags: Remove ---
  params = matchRoute(method, path, "DELETE", "/api/conversations/:id/tags/:tagId");
  if (params) {
    await env.DB.prepare(
      "DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id = ?"
    ).bind(params.id, params.tagId).run();
    return json({ ok: true });
  }

  // --- Annotations: Create/Replace (one per message) ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/annotations");
  if (params) {
    const body = (await request.json()) as { message_id: string; type: string; label?: string };
    const conversationId = params.id;

    if (!body.message_id || !body.type) {
      return error("message_id and type are required");
    }
    if (!["pin", "bookmark", "highlight"].includes(body.type)) {
      return error("type must be pin, bookmark, or highlight");
    }

    // Verify message exists and belongs to this conversation
    const msg = await env.DB.prepare(
      "SELECT id FROM messages WHERE id = ? AND conversation_id = ?"
    ).bind(body.message_id, conversationId).first();

    if (!msg) return error("Message not found in this conversation", 404);

    // Delete existing annotation on this message (if any), then insert new
    await env.DB.prepare(
      "DELETE FROM message_annotations WHERE message_id = ?"
    ).bind(body.message_id).run();

    const id = generateId();
    await env.DB.prepare(
      "INSERT INTO message_annotations (id, message_id, conversation_id, type, label) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, body.message_id, conversationId, body.type, body.label || null).run();

    return json({ id, message_id: body.message_id, conversation_id: conversationId, type: body.type, label: body.label || null }, 201);
  }

  // --- Annotations: List (with message preview) ---
  params = matchRoute(method, path, "GET", "/api/conversations/:id/annotations");
  if (params) {
    const typeFilter = url.searchParams.get("type");
    let query = "SELECT a.*, SUBSTR(m.content, 1, 200) as message_content, m.role as message_role FROM message_annotations a JOIN messages m ON a.message_id = m.id WHERE a.conversation_id = ?";
    const binds: string[] = [params.id];

    if (typeFilter && ["pin", "bookmark", "highlight"].includes(typeFilter)) {
      query += " AND a.type = ?";
      binds.push(typeFilter);
    }

    query += " ORDER BY a.created_at DESC";

    const { results } = await env.DB.prepare(query).bind(...binds).all();
    return json(results);
  }

  // --- Annotations: Update label ---
  params = matchRoute(method, path, "PUT", "/api/annotations/:id");
  if (params) {
    const body = (await request.json()) as { label?: string };
    await env.DB.prepare(
      "UPDATE message_annotations SET label = ? WHERE id = ?"
    ).bind(body.label || null, params.id).run();
    const updated = await env.DB.prepare(
      "SELECT * FROM message_annotations WHERE id = ?"
    ).bind(params.id).first();
    return json(updated);
  }

  // --- Annotations: Delete ---
  params = matchRoute(method, path, "DELETE", "/api/annotations/:id");
  if (params) {
    await env.DB.prepare(
      "DELETE FROM message_annotations WHERE id = ?"
    ).bind(params.id).run();
    return json({ ok: true });
  }

  return null; // No route matched
}
