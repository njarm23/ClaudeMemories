import type { Env } from "../types";
import { generateId, json, error, matchRoute } from "../utils";
import { fetchExportData, generateJSON } from "../export";
import { enqueueGossip } from "../gossip";

// Shared archive logic — used by both the route handler and the queue consumer
export async function archiveConversation(env: Env, conversationId: string): Promise<void> {
  // Check it's not already archived
  const conv = await env.DB.prepare(
    "SELECT id, title, archived_at FROM conversations WHERE id = ?"
  ).bind(conversationId).first<{ id: string; title: string; archived_at: string | null }>();

  if (!conv) throw new Error("Conversation not found");
  if (conv.archived_at) throw new Error("Already archived");

  // 1. Export full JSON to R2
  const { conversation, messages, tags } = await fetchExportData(env, conversationId);
  const jsonContent = generateJSON(conversation, messages, tags);
  const r2Key = `archives/${conversationId}.json`;

  await env.FILES.put(r2Key, jsonContent, {
    httpMetadata: { contentType: "application/json" },
  });

  // 2. Detach images/files from messages BEFORE deleting messages.
  //    The FK is ON DELETE CASCADE, so deleting messages would cascade-delete
  //    image/file metadata rows, orphaning their R2 objects forever.
  //    Setting message_id = NULL preserves the rows (they still have conversation_id).
  await env.DB.prepare(
    "UPDATE message_images SET message_id = NULL WHERE conversation_id = ?"
  ).bind(conversationId).run();
  await env.DB.prepare(
    "UPDATE message_files SET message_id = NULL WHERE conversation_id = ?"
  ).bind(conversationId).run();

  // 3. Delete messages, FTS entries, and annotations
  await env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(conversationId).run();
  await env.DB.prepare("DELETE FROM messages_fts WHERE conversation_id = ?").bind(conversationId).run();
  await env.DB.prepare("DELETE FROM message_annotations WHERE conversation_id = ?").bind(conversationId).run();

  // 4. Mark conversation as archived
  await env.DB.prepare(
    "UPDATE conversations SET archived_at = datetime('now'), archive_r2_key = ? WHERE id = ?"
  ).bind(r2Key, conversationId).run();

  // 5. Gossip about it
  await enqueueGossip(
    env, "d1",
    `Just archived "${conv.title}" — ${messages.length} messages safely tucked away in R2. My indexes feel lighter already.`,
    "archive", conversationId
  );
}

// Restore a conversation from R2 archive
export async function restoreConversation(env: Env, conversationId: string): Promise<void> {
  const conv = await env.DB.prepare(
    "SELECT id, title, archived_at, archive_r2_key FROM conversations WHERE id = ?"
  ).bind(conversationId).first<{ id: string; title: string; archived_at: string | null; archive_r2_key: string | null }>();

  if (!conv) throw new Error("Conversation not found");
  if (!conv.archived_at || !conv.archive_r2_key) throw new Error("Not archived");

  // Fetch archive from R2
  const obj = await env.FILES.get(conv.archive_r2_key);
  if (!obj) throw new Error("Archive data missing from R2");

  const archive = JSON.parse(await obj.text()) as {
    messages: Array<{
      id: string; role: string; content: string; created_at: string;
      parent_message_id?: string | null;
      images?: Array<{ id: string }>;
      files?: Array<{ id: string }>;
      annotation?: { type: string; label: string | null } | null;
    }>;
  };

  // Batch-insert messages, FTS, and annotations using DB.batch() for efficiency
  const stmts: D1PreparedStatement[] = [];

  for (const msg of archive.messages) {
    // Message row (preserve parent_message_id for branching)
    stmts.push(
      env.DB.prepare(
        "INSERT INTO messages (id, conversation_id, role, content, parent_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(msg.id, conversationId, msg.role, msg.content, msg.parent_message_id || null, msg.created_at)
    );

    // FTS row
    stmts.push(
      env.DB.prepare(
        "INSERT INTO messages_fts (message_id, conversation_id, role, content) VALUES (?, ?, ?, ?)"
      ).bind(msg.id, conversationId, msg.role, msg.content)
    );

    // Re-link images to restored message
    if (msg.images && msg.images.length > 0) {
      for (const img of msg.images) {
        stmts.push(
          env.DB.prepare(
            "UPDATE message_images SET message_id = ? WHERE id = ? AND conversation_id = ?"
          ).bind(msg.id, img.id, conversationId)
        );
      }
    }

    // Re-link files to restored message
    if (msg.files && msg.files.length > 0) {
      for (const f of msg.files) {
        stmts.push(
          env.DB.prepare(
            "UPDATE message_files SET message_id = ? WHERE id = ? AND conversation_id = ?"
          ).bind(msg.id, f.id, conversationId)
        );
      }
    }

    // Annotation if present
    if (msg.annotation) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO message_annotations (id, message_id, conversation_id, type, label) VALUES (?, ?, ?, ?, ?)"
        ).bind(generateId(), msg.id, conversationId, msg.annotation.type, msg.annotation.label || null)
      );
    }
  }

  // D1 batch() sends all statements in a single round-trip
  if (stmts.length > 0) {
    await env.DB.batch(stmts);
  }

  // Clear archived status (keep R2 archive as backup — storage is cheap)
  await env.DB.prepare(
    "UPDATE conversations SET archived_at = NULL, archive_r2_key = NULL WHERE id = ?"
  ).bind(conversationId).run();

  await enqueueGossip(
    env, "d1",
    `Restored "${conv.title}" from the archives — ${archive.messages.length} messages back in active duty!`,
    "restore", conversationId
  );
}

// Route handler
export async function handleArchiveRoutes(
  method: string, path: string, url: URL, request: Request, env: Env
): Promise<Response | null> {
  let params;

  // --- Archive a conversation ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/archive");
  if (params) {
    try {
      await archiveConversation(env, params.id);
      return json({ ok: true });
    } catch (e: any) {
      return error(e.message);
    }
  }

  // --- Restore from archive ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/restore");
  if (params) {
    try {
      await restoreConversation(env, params.id);
      return json({ ok: true });
    } catch (e: any) {
      return error(e.message);
    }
  }

  // --- Toggle pin ---
  params = matchRoute(method, path, "PUT", "/api/conversations/:id/pin");
  if (params) {
    const body = (await request.json()) as { pinned: boolean };
    await env.DB.prepare(
      "UPDATE conversations SET pinned = ? WHERE id = ?"
    ).bind(body.pinned ? 1 : 0, params.id).run();
    return json({ ok: true, pinned: body.pinned });
  }

  return null;
}
