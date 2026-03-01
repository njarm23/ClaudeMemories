import type { Env, QueueJob } from "./types";
import { generateId } from "./utils";
import { WORKERS, waterCoolerChat } from "./gossip";
import { summarizeConversation } from "./summarize";

async function processJob(job: QueueJob, env: Env): Promise<void> {
  switch (job.type) {
    case "gossip": {
      const worker = WORKERS[job.persona];
      await env.DB.prepare(
        "INSERT INTO gossip_messages (id, worker_name, worker_emoji, message, event_type, conversation_id) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(
          generateId(),
          worker.name,
          worker.emoji,
          job.message,
          job.eventType || null,
          job.conversationId || null
        )
        .run();
      break;
    }

    case "summarize_conversation": {
      await summarizeConversation(env, job.conversationId);
      break;
    }

    case "summarize_batch": {
      const { results } = await env.DB.prepare(`
        SELECT c.id FROM conversations c
        WHERE EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id
          AND (c.last_summarized_at IS NULL OR m.created_at > c.last_summarized_at)
        )
        AND (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) >= 4
        LIMIT 20
      `).all<{ id: string }>();

      if (results.length > 0) {
        await env.JOBS.sendBatch(
          results.map((c) => ({
            body: {
              type: "summarize_conversation" as const,
              conversationId: c.id,
            },
          }))
        );
      }
      break;
    }

    case "water_cooler": {
      await waterCoolerChat(env);
      break;
    }

    case "export_conversation": {
      const { exportConversation } = await import("./export");
      await exportConversation(env, job.conversationId, job.format);
      break;
    }

    case "wiki_snapshot": {
      const r2Key = `wiki-versions/${job.pageId}/${job.editedAt}.md`;
      await env.FILES.put(r2Key, job.content);

      const latest = await env.DB.prepare(
        "SELECT MAX(version_number) as max_v FROM wiki_page_versions WHERE page_id = ?"
      )
        .bind(job.pageId)
        .first<{ max_v: number | null }>();
      const versionNumber = (latest?.max_v ?? 0) + 1;

      await env.DB.prepare(
        "INSERT INTO wiki_page_versions (id, page_id, version_number, title, r2_key, size_bytes) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(
          generateId(),
          job.pageId,
          versionNumber,
          job.title,
          r2Key,
          job.content.length
        )
        .run();

      // Prune: keep only last 50 versions per page
      await env.DB.prepare(`
        DELETE FROM wiki_page_versions WHERE page_id = ? AND id NOT IN (
          SELECT id FROM wiki_page_versions WHERE page_id = ? ORDER BY version_number DESC LIMIT 50
        )
      `)
        .bind(job.pageId, job.pageId)
        .run();
      break;
    }

    case "archive_batch": {
      // Find conversations older than 90 days, not pinned, not already archived
      const { results: archivable } = await env.DB.prepare(`
        SELECT c.id FROM conversations c
        WHERE c.pinned = 0
          AND c.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.conversation_id = c.id
              AND m.created_at > datetime('now', '-90 days')
          )
          AND EXISTS (
            SELECT 1 FROM messages m WHERE m.conversation_id = c.id
          )
        LIMIT 20
      `).all<{ id: string }>();

      if (archivable.length > 0) {
        await env.JOBS.sendBatch(
          archivable.map((c) => ({
            body: {
              type: "archive_conversation" as const,
              conversationId: c.id,
            },
          }))
        );
      }
      break;
    }

    case "archive_conversation": {
      const { archiveConversation } = await import("./routes/archive");
      await archiveConversation(env, job.conversationId);
      break;
    }

    case "database_backup": {
      const tables = [
        "conversations",
        "messages",
        "gossip_messages",
        "message_images",
        "message_files",
        "tags",
        "conversation_tags",
        "message_annotations",
        "wiki_categories",
        "wiki_pages",
        "wiki_page_tags",
        "conversation_wiki_pins",
        "wiki_page_versions",
        "conversation_wiki_generations",
      ];

      const backup: Record<string, unknown[]> = {};
      for (const table of tables) {
        try {
          const { results } = await env.DB.prepare(
            `SELECT * FROM ${table}`
          ).all();
          backup[table] = results;
        } catch {
          // Table might not exist yet — skip gracefully
          backup[table] = [];
        }
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-");
      const key = `backups/d1-${timestamp}.json`;
      await env.FILES.put(key, JSON.stringify(backup, null, 2), {
        httpMetadata: { contentType: "application/json" },
      });

      // Prune: keep last 10 backups
      const { objects } = await env.FILES.list({ prefix: "backups/d1-" });
      if (objects.length > 10) {
        const toDelete = objects
          .sort((a, b) => (a.uploaded < b.uploaded ? -1 : 1))
          .slice(0, objects.length - 10)
          .map((o) => o.key);
        await env.FILES.delete(toDelete);
      }
      break;
    }

    default: {
      console.error("Unknown job type:", (job as { type: string }).type);
    }
  }
}

export async function handleQueue(
  batch: MessageBatch<QueueJob>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processJob(msg.body, env);
      msg.ack();
    } catch (err) {
      console.error(
        `Job failed (attempt ${msg.attempts}):`,
        msg.body.type,
        err
      );
      msg.retry();
    }
  }
}
