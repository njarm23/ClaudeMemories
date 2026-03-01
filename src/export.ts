import type { Env } from "./types";

interface ExportMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
  parent_message_id: string | null;
  images: Array<{ id: string; original_filename: string | null }>;
  files: Array<{ id: string; original_filename: string | null; media_type: string; size_bytes: number }>;
}

interface ExportConversation {
  id: string;
  title: string;
  model: string;
  temperature: number;
  system_prompt: string;
  summary: string | null;
  vibes: string | null;
  created_at: string;
}

export async function fetchExportData(env: Env, conversationId: string) {
  const conversation = await env.DB.prepare(
    "SELECT id, title, model, temperature, system_prompt, summary, vibes, created_at FROM conversations WHERE id = ?"
  )
    .bind(conversationId)
    .first<ExportConversation>();

  if (!conversation) throw new Error("Conversation not found");

  const { results: messages } = await env.DB.prepare(
    "SELECT id, role, content, created_at, parent_message_id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
  )
    .bind(conversationId)
    .all<{ id: string; role: string; content: string; created_at: string; parent_message_id: string | null }>();

  const { results: images } = await env.DB.prepare(
    "SELECT id, message_id, original_filename FROM message_images WHERE conversation_id = ? AND message_id IS NOT NULL"
  )
    .bind(conversationId)
    .all<{ id: string; message_id: string; original_filename: string | null }>();

  const { results: files } = await env.DB.prepare(
    "SELECT id, message_id, original_filename, media_type, size_bytes FROM message_files WHERE conversation_id = ? AND message_id IS NOT NULL"
  )
    .bind(conversationId)
    .all<{ id: string; message_id: string; original_filename: string | null; media_type: string; size_bytes: number }>();

  const { results: tags } = await env.DB.prepare(
    "SELECT t.name, t.color FROM conversation_tags ct JOIN tags t ON ct.tag_id = t.id WHERE ct.conversation_id = ?"
  )
    .bind(conversationId)
    .all<{ name: string; color: string | null }>();

  const { results: annotations } = await env.DB.prepare(
    "SELECT message_id, type, label FROM message_annotations WHERE conversation_id = ?"
  )
    .bind(conversationId)
    .all<{ message_id: string; type: string; label: string | null }>();

  // Group images and files by message
  const imagesByMsg = new Map<string, typeof images>();
  for (const img of images) {
    const arr = imagesByMsg.get(img.message_id) || [];
    arr.push(img);
    imagesByMsg.set(img.message_id, arr);
  }

  const filesByMsg = new Map<string, typeof files>();
  for (const f of files) {
    const arr = filesByMsg.get(f.message_id) || [];
    arr.push(f);
    filesByMsg.set(f.message_id, arr);
  }

  const annotationByMsg = new Map<string, { type: string; label: string | null }>();
  for (const ann of annotations) {
    annotationByMsg.set(ann.message_id, { type: ann.type, label: ann.label });
  }

  const enrichedMessages: (ExportMessage & { annotation?: { type: string; label: string | null } })[] =
    messages.map((m) => ({
      ...m,
      parent_message_id: m.parent_message_id ?? null,
      images: (imagesByMsg.get(m.id) || []).map((i) => ({ id: i.id, original_filename: i.original_filename })),
      files: (filesByMsg.get(m.id) || []).map((f) => ({
        id: f.id,
        original_filename: f.original_filename,
        media_type: f.media_type,
        size_bytes: f.size_bytes,
      })),
      annotation: annotationByMsg.get(m.id),
    }));

  return { conversation, messages: enrichedMessages, tags };
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso + "Z");
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function generateMarkdown(
  conversation: ExportConversation,
  messages: Awaited<ReturnType<typeof fetchExportData>>["messages"],
  tags: Array<{ name: string; color: string | null }>
): string {
  const vibes = conversation.vibes ? JSON.parse(conversation.vibes) : [];
  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`title: "${conversation.title.replace(/"/g, '\\"')}"`);
  lines.push(`model: ${conversation.model}`);
  lines.push(`temperature: ${conversation.temperature}`);
  lines.push(`created: ${conversation.created_at}`);
  lines.push(`exported: ${new Date().toISOString()}`);
  lines.push(`messages: ${messages.length}`);
  if (tags.length > 0) {
    lines.push(`tags: [${tags.map((t) => `"${t.name}"`).join(", ")}]`);
  }
  if (vibes.length > 0) {
    lines.push(`vibes: [${vibes.map((v: string) => `"${v}"`).join(", ")}]`);
  }
  if (conversation.summary) {
    lines.push(`summary: "${conversation.summary.replace(/"/g, '\\"')}"`);
  }
  lines.push("---");
  lines.push("");
  lines.push(`# ${conversation.title}`);
  lines.push("");

  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Claude";
    const time = formatTimestamp(msg.created_at);
    const annotation = msg.annotation
      ? ` ${msg.annotation.type === "pin" ? "📌" : msg.annotation.type === "bookmark" ? "🔖" : "⭐"}${msg.annotation.label ? ` ${msg.annotation.label}` : ""}`
      : "";

    lines.push(`## ${role} — ${time}${annotation}`);
    lines.push("");

    // Show attached images
    if (msg.images.length > 0) {
      for (const img of msg.images) {
        const name = img.original_filename || `image-${img.id}`;
        lines.push(`![${name}](/api/images/${img.id})`);
      }
      lines.push("");
    }

    // Show attached files
    if (msg.files.length > 0) {
      for (const f of msg.files) {
        const name = f.original_filename || `file-${f.id}`;
        const size = f.size_bytes < 1024
          ? `${f.size_bytes}B`
          : `${(f.size_bytes / 1024).toFixed(0)}KB`;
        lines.push(`📎 [${name}](/api/files/${f.id}) (${size})`);
      }
      lines.push("");
    }

    lines.push(msg.content);
    lines.push("");
  }

  return lines.join("\n");
}

export function generateJSON(
  conversation: ExportConversation,
  messages: Awaited<ReturnType<typeof fetchExportData>>["messages"],
  tags: Array<{ name: string; color: string | null }>
): string {
  return JSON.stringify(
    {
      version: 1,
      conversation: {
        ...conversation,
        vibes: conversation.vibes ? JSON.parse(conversation.vibes) : [],
        tags,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        created_at: m.created_at,
        parent_message_id: m.parent_message_id ?? null,
        images: m.images.map((i) => ({
          id: i.id,
          filename: i.original_filename,
          url: `/api/images/${i.id}`,
        })),
        files: m.files.map((f) => ({
          id: f.id,
          filename: f.original_filename,
          media_type: f.media_type,
          size_bytes: f.size_bytes,
          url: `/api/files/${f.id}`,
        })),
        annotation: m.annotation || null,
      })),
      exported_at: new Date().toISOString(),
    },
    null,
    2
  );
}

// Called from queue consumer or directly from route handler
export async function exportConversation(
  env: Env,
  conversationId: string,
  format: "markdown" | "json"
): Promise<{ r2Key: string; size: number }> {
  const { conversation, messages, tags } = await fetchExportData(env, conversationId);

  const content =
    format === "markdown"
      ? generateMarkdown(conversation, messages, tags)
      : generateJSON(conversation, messages, tags);

  const ext = format === "markdown" ? "md" : "json";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const r2Key = `exports/${conversationId}/${timestamp}.${ext}`;

  await env.FILES.put(r2Key, content, {
    httpMetadata: {
      contentType: format === "markdown" ? "text/markdown" : "application/json",
    },
  });

  return { r2Key, size: content.length };
}
