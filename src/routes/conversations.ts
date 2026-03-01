import type { Env } from "../types";
import { generateId, json, error, matchRoute, ALLOWED_IMAGE_TYPES, MAX_IMAGE_SIZE, extFromMediaType } from "../utils";
import { enqueueGossip } from "../gossip";

// Image serve — called pre-auth from index.ts
export async function handleImageServe(method: string, path: string, env: Env): Promise<Response | null> {
  const params = matchRoute(method, path, "GET", "/api/images/:id");
  if (!params) return null;

  const imgRecord = await env.DB.prepare(
    "SELECT r2_key, media_type FROM message_images WHERE id = ?"
  ).bind(params.id).first<{ r2_key: string; media_type: string }>();

  if (!imgRecord) return error("Image not found", 404);

  const obj = await env.IMAGES.get(imgRecord.r2_key);
  if (!obj) return error("Image file missing", 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": imgRecord.media_type,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// All authenticated conversation routes
export async function handleConversationRoutes(
  method: string, path: string, url: URL, request: Request, env: Env, ctx: ExecutionContext
): Promise<Response | null> {
  let params;

  // --- Conversations: List (with tags) ---
  params = matchRoute(method, path, "GET", "/api/conversations");
  if (params) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM conversations ORDER BY updated_at DESC"
    ).all();

    // Fetch all conversation-tag assignments in one query
    const { results: allCT } = await env.DB.prepare(
      "SELECT ct.conversation_id, t.id, t.name, t.color FROM conversation_tags ct JOIN tags t ON ct.tag_id = t.id"
    ).all<{ conversation_id: string; id: string; name: string; color: string | null }>();

    const tagsByConv = new Map<string, Array<{ id: string; name: string; color: string | null }>>();
    for (const ct of allCT) {
      const arr = tagsByConv.get(ct.conversation_id) || [];
      arr.push({ id: ct.id, name: ct.name, color: ct.color });
      tagsByConv.set(ct.conversation_id, arr);
    }

    const enriched = results.map((c: any) => ({
      ...c,
      tags: tagsByConv.get(c.id) || [],
    }));

    return json(enriched);
  }

  // --- Conversations: Create ---
  params = matchRoute(method, path, "POST", "/api/conversations");
  if (params) {
    const body = (await request.json()) as { title?: string; model?: string; temperature?: number; system_prompt?: string };
    const id = generateId();
    const title = body.title || "New Chat";
    const model = body.model || "claude-sonnet-4-20250514";
    const temperature = body.temperature ?? 1.0;
    const system_prompt = body.system_prompt ?? "";
    await env.DB.prepare(
      "INSERT INTO conversations (id, title, model, temperature, system_prompt) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(id, title, model, temperature, system_prompt)
      .run();
    // 🚰 Gossip: new conversation
    ctx.waitUntil(enqueueGossip(env, "gateway", `New conversation just walked in! "${title}" on ${model.split("-").slice(0,2).join("-")}. Let's see where this goes 👀`, "new_conversation", id));
    return json({ id, title, model, temperature, system_prompt }, 201);
  }

  // --- Conversations: Update ---
  params = matchRoute(method, path, "PUT", "/api/conversations/:id");
  if (params) {
    const body = (await request.json()) as { title?: string; model?: string; temperature?: number; system_prompt?: string; handoff_notes?: string };
    const updates: string[] = [];
    const values: (string | number)[] = [];
    if (body.title) {
      updates.push("title = ?");
      values.push(body.title);
    }
    if (body.model) {
      updates.push("model = ?");
      values.push(body.model);
    }
    if (body.temperature !== undefined) {
      updates.push("temperature = ?");
      values.push(body.temperature);
    }
    if (body.system_prompt !== undefined) {
      updates.push("system_prompt = ?");
      values.push(body.system_prompt);
    }
    if (body.handoff_notes !== undefined) {
      updates.push("handoff_notes = ?");
      values.push(body.handoff_notes);
    }
    if (updates.length === 0) return error("Nothing to update");
    updates.push("updated_at = datetime('now')");
    values.push(params.id);
    await env.DB.prepare(
      `UPDATE conversations SET ${updates.join(", ")} WHERE id = ?`
    )
      .bind(...values)
      .run();
    return json({ ok: true });
  }

  // --- Conversations: Delete ---
  params = matchRoute(method, path, "DELETE", "/api/conversations/:id");
  if (params) {
    // Collect R2 keys for images and files BEFORE deleting D1 rows (cascade would orphan them).
    // Query by conversation_id directly (not JOIN through messages) to also catch
    // orphaned uploads where message_id IS NULL (user uploaded but never sent the message).
    const { results: imageRows } = await env.DB.prepare(
      "SELECT r2_key FROM message_images WHERE conversation_id = ?"
    ).bind(params.id).all<{ r2_key: string }>();

    const { results: fileRows } = await env.DB.prepare(
      "SELECT r2_key FROM message_files WHERE conversation_id = ?"
    ).bind(params.id).all<{ r2_key: string }>();

    // Clean up FTS entries first (FTS5 tables don't support CASCADE)
    await env.DB.prepare("DELETE FROM messages_fts WHERE conversation_id = ?")
      .bind(params.id)
      .run();
    // Explicitly delete image/file rows (orphaned ones with message_id=NULL
    // won't cascade from message deletion, and there's no FK on conversation_id)
    await env.DB.prepare("DELETE FROM message_images WHERE conversation_id = ?")
      .bind(params.id)
      .run();
    await env.DB.prepare("DELETE FROM message_files WHERE conversation_id = ?")
      .bind(params.id)
      .run();
    await env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?")
      .bind(params.id)
      .run();
    await env.DB.prepare("DELETE FROM conversations WHERE id = ?")
      .bind(params.id)
      .run();

    // Clean up R2 objects (fire-and-forget via waitUntil)
    if (imageRows.length > 0) {
      const r2Keys = imageRows.map(r => r.r2_key);
      ctx.waitUntil(env.IMAGES.delete(r2Keys));
    }
    if (fileRows.length > 0) {
      const r2Keys = fileRows.map(r => r.r2_key);
      ctx.waitUntil(env.FILES.delete(r2Keys));
    }

    // 🚰 Gossip: conversation deleted
    ctx.waitUntil(enqueueGossip(env, "d1", `Another conversation just got wiped. All those carefully indexed rows... gone. I'm fine. 🥲`, "conversation_deleted"));
    return json({ ok: true });
  }

  // --- Messages: List (with image metadata) ---
  params = matchRoute(method, path, "GET", "/api/conversations/:id/messages");
  if (params) {
    const { results: msgs } = await env.DB.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
    )
      .bind(params.id)
      .all();

    // Fetch image metadata for all linked messages in one query
    const { results: images } = await env.DB.prepare(
      "SELECT id, message_id, media_type, original_filename FROM message_images WHERE conversation_id = ? AND message_id IS NOT NULL"
    )
      .bind(params.id)
      .all<{ id: string; message_id: string; media_type: string; original_filename: string | null }>();

    // Group images by message_id
    const imagesByMsg = new Map<string, typeof images>();
    for (const img of images) {
      const arr = imagesByMsg.get(img.message_id) || [];
      arr.push(img);
      imagesByMsg.set(img.message_id, arr);
    }

    // Fetch file metadata for all linked messages
    const { results: files } = await env.DB.prepare(
      "SELECT id, message_id, media_type, original_filename, size_bytes FROM message_files WHERE conversation_id = ? AND message_id IS NOT NULL"
    )
      .bind(params.id)
      .all<{ id: string; message_id: string; media_type: string; original_filename: string | null; size_bytes: number }>();

    const filesByMsg = new Map<string, typeof files>();
    for (const f of files) {
      const arr = filesByMsg.get(f.message_id) || [];
      arr.push(f);
      filesByMsg.set(f.message_id, arr);
    }

    // Fetch annotations for this conversation
    const { results: annotations } = await env.DB.prepare(
      "SELECT id, message_id, type, label, created_at FROM message_annotations WHERE conversation_id = ?"
    ).bind(params.id).all<{ id: string; message_id: string; type: string; label: string | null; created_at: string }>();

    const annotationByMsg = new Map<string, { id: string; type: string; label: string | null; created_at: string }>();
    for (const ann of annotations) {
      annotationByMsg.set(ann.message_id, { id: ann.id, type: ann.type, label: ann.label, created_at: ann.created_at });
    }

    // Attach images, files, and annotations to their messages
    const enriched = msgs.map((m: any) => ({
      ...m,
      images: imagesByMsg.get(m.id) || [],
      files: filesByMsg.get(m.id) || [],
      annotation: annotationByMsg.get(m.id) || null,
    }));

    return json(enriched);
  }

  // --- Images: Upload ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/images");
  if (params) {
    try {
      const conversationId = params.id;

      // Verify conversation exists
      const conv = await env.DB.prepare("SELECT id FROM conversations WHERE id = ?")
        .bind(conversationId).first();
      if (!conv) return error("Conversation not found", 404);

      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      if (!file) return error("No file provided");

      if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
        return error(`Unsupported image type: ${file.type}. Use PNG, JPEG, GIF, or WebP.`);
      }
      if (file.size > MAX_IMAGE_SIZE) {
        return error(`Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.`);
      }

      const imageId = generateId();
      const ext = extFromMediaType(file.type);
      const r2Key = `${conversationId}/${imageId}.${ext}`;

      // Store in R2 (use arrayBuffer — file.stream() can be consumed already in some runtimes)
      await env.IMAGES.put(r2Key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
      });

      // Store metadata in D1 (message_id is NULL until linked when message is sent)
      await env.DB.prepare(
        "INSERT INTO message_images (id, message_id, conversation_id, r2_key, media_type, original_filename, size_bytes) VALUES (?, NULL, ?, ?, ?, ?, ?)"
      )
        .bind(imageId, conversationId, r2Key, file.type, file.name || null, file.size)
        .run();

      // 🚰 Gossip: image uploaded
      ctx.waitUntil(enqueueGossip(env, "gateway",
        `Someone just uploaded a ${(file.size / 1024).toFixed(0)}KB ${ext.toUpperCase()}! Stream, time to flex those vision muscles 👁️🖼️`,
        "image_uploaded", conversationId));

      return json({ id: imageId, media_type: file.type, original_filename: file.name, size_bytes: file.size }, 201);
    } catch (e: any) {
      return error(`Image upload failed: ${e.message}`, 500);
    }
  }

  return null; // No route matched
}
