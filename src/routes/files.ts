import type { Env } from "../types";
import { generateId, json, error, matchRoute, getFileConfig, extFromFilename, MAX_FILE_SIZE, ALLOWED_IMAGE_TYPES } from "../utils";
import { enqueueGossip } from "../gossip";

// File serve — called pre-auth from index.ts (files are immutable, keyed by UUID)
export async function handleFileServe(method: string, path: string, env: Env): Promise<Response | null> {
  const params = matchRoute(method, path, "GET", "/api/files/:id");
  if (!params) return null;

  const fileRecord = await env.DB.prepare(
    "SELECT r2_key, media_type, original_filename FROM message_files WHERE id = ?"
  ).bind(params.id).first<{ r2_key: string; media_type: string; original_filename: string | null }>();

  if (!fileRecord) return error("File not found", 404);

  const obj = await env.FILES.get(fileRecord.r2_key);
  if (!obj) return error("File missing from storage", 404);

  const filename = fileRecord.original_filename || `file-${params.id}`;
  return new Response(obj.body, {
    headers: {
      "Content-Type": fileRecord.media_type,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// Authenticated file routes
export async function handleFileRoutes(
  method: string, path: string, url: URL, request: Request, env: Env, ctx: ExecutionContext
): Promise<Response | null> {
  let params;

  // --- Files: Upload ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/files");
  if (params) {
    try {
      const conversationId = params.id;

      const conv = await env.DB.prepare("SELECT id FROM conversations WHERE id = ?")
        .bind(conversationId).first();
      if (!conv) return error("Conversation not found", 404);

      const formData = await request.formData();
      const file = formData.get("file") as File | null;
      if (!file) return error("No file provided");

      // Reject images — those go through the images endpoint
      if (ALLOWED_IMAGE_TYPES.has(file.type)) {
        return error("Use the images endpoint for image files");
      }

      const config = getFileConfig(file.type, file.name);
      if (file.size > config.maxSize) {
        return error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max ${(config.maxSize / 1024 / 1024).toFixed(0)}MB for this type.`);
      }
      if (file.size > MAX_FILE_SIZE) {
        return error(`File exceeds absolute max size of ${MAX_FILE_SIZE / 1024 / 1024}MB`);
      }

      const fileId = generateId();
      const ext = extFromFilename(file.name || "file.bin");
      const r2Key = `attachments/${conversationId}/${fileId}.${ext}`;

      await env.FILES.put(r2Key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
      });

      await env.DB.prepare(
        "INSERT INTO message_files (id, message_id, conversation_id, r2_key, media_type, original_filename, size_bytes) VALUES (?, NULL, ?, ?, ?, ?, ?)"
      )
        .bind(fileId, conversationId, r2Key, file.type, file.name || null, file.size)
        .run();

      ctx.waitUntil(enqueueGossip(env, "gateway",
        `File incoming! ${file.name || "unnamed"} (${(file.size / 1024).toFixed(0)}KB ${ext.toUpperCase()}). ${config.claudeSupport !== "none" ? "Claude can read this one 📄" : "Stored for safekeeping 📦"}`,
        "file_uploaded", conversationId));

      return json({
        id: fileId,
        media_type: file.type,
        original_filename: file.name,
        size_bytes: file.size,
        claude_support: config.claudeSupport,
      }, 201);
    } catch (e: any) {
      return error(`File upload failed: ${e.message}`, 500);
    }
  }

  return null;
}
