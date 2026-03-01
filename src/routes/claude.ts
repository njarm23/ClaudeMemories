import type { Env } from "../types";
import { generateId, json, error, matchRoute, getFileConfig } from "../utils";
import { enqueueGossip } from "../gossip";
import { extractModelFromSSE, trackModel } from "../model-detector";

// --- Shared types ---
interface ConversationSettings {
  id: string;
  title: string;
  model: string;
  temperature: number;
  system_prompt: string;
  vibes: string | null;
  handoff_notes: string | null;
}

interface ContextMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

// --- Tree traversal: walk from leaf to root via parent_message_id ---
async function getAncestorChain(
  db: D1Database,
  conversationId: string,
  leafMessageId: string,
  limit: number = 50
): Promise<ContextMessage[]> {
  const { results: allMessages } = await db.prepare(
    "SELECT id, role, content, created_at, parent_message_id FROM messages WHERE conversation_id = ?"
  ).bind(conversationId)
   .all<ContextMessage & { parent_message_id: string | null }>();

  const messageMap = new Map(allMessages.map(m => [m.id, m]));

  // Walk from leaf to root
  const chain: ContextMessage[] = [];
  let currentId: string | null = leafMessageId;
  const visited = new Set<string>(); // cycle protection
  while (currentId && chain.length < limit) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const msg = messageMap.get(currentId);
    if (!msg) break;
    chain.push({ id: msg.id, role: msg.role, content: msg.content, created_at: msg.created_at });
    currentId = msg.parent_message_id;
  }

  chain.reverse(); // chronological order (root first)
  return chain;
}

// --- Helper: ArrayBuffer → base64 in chunks (avoids call stack overflow) ---
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

// --- Build Claude API messages array with multimodal content ---
async function buildClaudeMessages(
  env: Env,
  contextMessages: ContextMessage[]
): Promise<Array<{ role: string; content: string | Array<Record<string, unknown>> }>> {
  // Fetch images for recent user messages (last 5 user messages to save context)
  const recentUserMsgIds = contextMessages
    .filter(m => m.role === "user")
    .slice(-5)
    .map(m => m.id);

  const imageMap = new Map<string, Array<{ r2_key: string; media_type: string }>>();
  if (recentUserMsgIds.length > 0) {
    const placeholders = recentUserMsgIds.map(() => "?").join(",");
    const { results: msgImages } = await env.DB.prepare(
      `SELECT message_id, r2_key, media_type FROM message_images WHERE message_id IN (${placeholders})`
    ).bind(...recentUserMsgIds).all<{ message_id: string; r2_key: string; media_type: string }>();

    for (const img of msgImages) {
      const arr = imageMap.get(img.message_id) || [];
      arr.push(img);
      imageMap.set(img.message_id, arr);
    }
  }

  // Fetch file attachments for recent user messages
  const fileMap = new Map<string, Array<{ r2_key: string; media_type: string; original_filename: string | null }>>();
  if (recentUserMsgIds.length > 0) {
    const placeholders = recentUserMsgIds.map(() => "?").join(",");
    const { results: msgFiles } = await env.DB.prepare(
      `SELECT message_id, r2_key, media_type, original_filename FROM message_files WHERE message_id IN (${placeholders})`
    ).bind(...recentUserMsgIds).all<{ message_id: string; r2_key: string; media_type: string; original_filename: string | null }>();

    for (const f of msgFiles) {
      const arr = fileMap.get(f.message_id) || [];
      arr.push(f);
      fileMap.set(f.message_id, arr);
    }
  }

  // Build Claude message array
  const claudeMessages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];
  for (const m of contextMessages) {
    const msgImages = imageMap.get(m.id);
    const msgFiles = fileMap.get(m.id);
    const hasAttachments = (msgImages && msgImages.length > 0) || (msgFiles && msgFiles.length > 0);

    if (hasAttachments) {
      const contentParts: Array<Record<string, unknown>> = [];

      if (msgImages) {
        for (const img of msgImages) {
          const obj = await env.IMAGES.get(img.r2_key);
          if (obj) {
            const base64 = toBase64(await obj.arrayBuffer());
            contentParts.push({
              type: "image",
              source: { type: "base64", media_type: img.media_type, data: base64 },
            });
          }
        }
      }

      if (msgFiles) {
        for (const f of msgFiles) {
          const config = getFileConfig(f.media_type, f.original_filename || undefined);
          if (config.claudeSupport === "none") continue;

          const obj = await env.FILES.get(f.r2_key);
          if (!obj) continue;

          if (config.claudeSupport === "native" && f.media_type === "application/pdf") {
            const base64 = toBase64(await obj.arrayBuffer());
            contentParts.push({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: base64 },
            });
          } else if (config.claudeSupport === "text") {
            const text = await obj.text();
            const filename = f.original_filename || "file";
            contentParts.push({
              type: "text",
              text: `--- File: ${filename} ---\n${text}\n--- End of ${filename} ---`,
            });
          }
        }
      }

      contentParts.push({ type: "text", text: m.content });
      claudeMessages.push({ role: m.role, content: contentParts });
    } else {
      claudeMessages.push({ role: m.role, content: m.content });
    }
  }

  return claudeMessages;
}

// --- Build system prompt (time, vibes, annotations, wiki, wikilinks) ---
async function buildSystemPrompt(
  env: Env,
  conversationId: string,
  conversation: ConversationSettings,
  userMessageContent: string
): Promise<string> {
  const systemParts: string[] = [];

  // Time context
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  systemParts.push(
    `[Current time: ${timeStr} (Pacific Time). Be naturally aware of the time of day, day of week, and season without explicitly stating this unless relevant.]`
  );

  // Vibes
  if (conversation.vibes) {
    try {
      const vibes = JSON.parse(conversation.vibes) as string[];
      if (vibes.length > 0) {
        systemParts.push(
          `[Conversation context: The energy of this conversation has been ${vibes.join(", ")}. Match this tone naturally without explicitly mentioning these vibes.]`
        );
      }
    } catch {
      // Ignore malformed vibes
    }
  }

  // Handoff notes
  if (conversation.handoff_notes) {
    systemParts.push(
      `[Session Handoff Notes from a previous context window — use these to maintain continuity:\n${conversation.handoff_notes}\n]`
    );
  }

  // Annotations
  const { results: convAnnotations } = await env.DB.prepare(
    "SELECT a.type, a.label, SUBSTR(m.content, 1, 300) as message_content, m.role as message_role FROM message_annotations a JOIN messages m ON a.message_id = m.id WHERE a.conversation_id = ? ORDER BY a.created_at ASC"
  ).bind(conversationId).all<{ type: string; label: string | null; message_content: string; message_role: string }>();

  if (convAnnotations.length > 0) {
    const annotationLines = convAnnotations.map((a) => {
      const role = a.message_role === "user" ? "User" : "Assistant";
      const typeLabel = a.type === "pin" ? "📌 Pinned" : a.type === "bookmark" ? "🔖 Bookmarked" : "⭐ Highlighted";
      const note = a.label ? ` — Note: "${a.label}"` : "";
      const preview = a.message_content.length >= 300 ? a.message_content + "..." : a.message_content;
      return `- ${typeLabel} (${role})${note}: "${preview}"`;
    });
    systemParts.push(
      `[User-annotated messages — the user has marked these as important. Reference them naturally when relevant, but don't list them unprompted:\n${annotationLines.join("\n")}\n]`
    );
  }

  // Pinned wiki pages
  const { results: pinnedWikiPages } = await env.DB.prepare(
    `SELECT wp.id, wp.title, wp.content FROM conversation_wiki_pins cwp
     JOIN wiki_pages wp ON cwp.page_id = wp.id WHERE cwp.conversation_id = ?
     ORDER BY cwp.created_at ASC`
  ).bind(conversationId).all<{ id: string; title: string; content: string }>();

  if (pinnedWikiPages.length > 0) {
    const MAX_PER_PAGE = 4000;
    const MAX_TOTAL = 12000;
    let totalChars = 0;
    const pageSections: string[] = [];
    for (const p of pinnedWikiPages) {
      if (totalChars >= MAX_TOTAL) break;
      const truncated = p.content.length > MAX_PER_PAGE
        ? p.content.slice(0, MAX_PER_PAGE) + "\n\n...[truncated — full page available in wiki]"
        : p.content;
      pageSections.push(`### ${p.title}\n${truncated}`);
      totalChars += truncated.length;
    }
    systemParts.push(
      `[Pinned Wiki Pages — the user has pinned these knowledge base articles to this conversation. Reference them when relevant:\n\n${pageSections.join("\n\n---\n\n")}\n]`
    );
  }

  const pinnedIds = new Set(pinnedWikiPages.map(p => p.id));

  // On-demand [[wikilink]] lookup
  const wikiLinkMatches = [...userMessageContent.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
  const referencedIds = new Set<string>();
  if (wikiLinkMatches.length > 0) {
    const linkSections: string[] = [];
    let linkChars = 0;
    const MAX_LINK_CHARS = 12000;
    for (const title of wikiLinkMatches.slice(0, 5)) {
      if (linkChars >= MAX_LINK_CHARS) break;
      try {
        const { results: found } = await env.DB.prepare(
          `SELECT id, title, content FROM wiki_pages WHERE LOWER(title) = LOWER(?) OR LOWER(slug) = LOWER(?) LIMIT 1`
        ).bind(title.trim(), title.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-")).all<{ id: string; title: string; content: string }>();
        if (found.length > 0 && !pinnedIds.has(found[0].id)) {
          referencedIds.add(found[0].id);
          const p = found[0];
          const truncated = p.content.length > 4000
            ? p.content.slice(0, 4000) + "\n\n...[truncated]"
            : p.content;
          linkSections.push(`### ${p.title}\n${truncated}`);
          linkChars += truncated.length;
        }
      } catch (e) {
        console.error("Wikilink lookup failed for:", title, e);
      }
    }
    if (linkSections.length > 0) {
      systemParts.push(
        `[Wiki pages referenced by user with [[wikilinks]] — they are asking about these:\n\n${linkSections.join("\n\n---\n\n")}\n]`
      );
    }
  }

  // Auto-discover relevant wiki pages based on user's message
  try {
    const wikiQuery = /[^\w\s]/.test(userMessageContent)
      ? `"${userMessageContent.slice(0, 100).replace(/"/g, '""')}"`
      : userMessageContent.slice(0, 100);
    const { results: discoveredPages } = await env.DB.prepare(
      `SELECT f.page_id, wp.title, wp.summary FROM wiki_fts f
       JOIN wiki_pages wp ON f.page_id = wp.id WHERE wiki_fts MATCH ? ORDER BY rank LIMIT 3`
    ).bind(wikiQuery).all<{ page_id: string; title: string; summary: string | null }>();

    const autoPages = discoveredPages.filter(p => !pinnedIds.has(p.page_id) && !referencedIds.has(p.page_id));
    if (autoPages.length > 0) {
      const autoLines = autoPages.map(p =>
        `- "${p.title}"${p.summary ? ": " + p.summary : ""}`
      ).join("\n");
      systemParts.push(
        `[Potentially relevant wiki pages (the user can pin them for full content if needed):\n${autoLines}\n]`
      );
    }
  } catch {
    // FTS match can fail on unusual queries — silently skip auto-discovery
  }

  if (conversation.system_prompt) {
    systemParts.push(conversation.system_prompt);
  }

  return systemParts.join("\n\n");
}

// --- Stream Claude response and save assistant message ---
async function streamClaudeResponse(
  env: Env,
  ctx: ExecutionContext,
  conversationId: string,
  conversation: ConversationSettings,
  claudeMessages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
  systemPrompt: string,
  parentMessageId: string,
  opts?: { autoTitleContent?: string; contextLength?: number }
): Promise<Response> {
  // Call Claude API with streaming
  const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: conversation.model,
      max_tokens: 4096,
      temperature: conversation.temperature,
      stream: true,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: claudeMessages,
    }),
  });

  if (!claudeResponse.ok) {
    const errBody = await claudeResponse.text();
    ctx.waitUntil(enqueueGossip(env, "stream", `MAYDAY! Claude API just hit me with a ${claudeResponse.status}. I was SO ready to stream that response too 😤`, "api_error", conversationId));
    return error(`Claude API error: ${errBody}`, claudeResponse.status);
  }

  // Stream the Anthropic response to the client using TransformStream
  const assistantMsgId = generateId();
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const streamPromise = (async () => {
    const anthropicReader = claudeResponse.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let buffer = "";
    let detectedModel = "unknown";

    try {
      while (true) {
        const { done, value } = await anthropicReader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop()!;

        for (const eventBlock of events) {
          if (!eventBlock.trim()) continue;

          const lines = eventBlock.split("\n");
          let eventType = "";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7).trim();
            else if (line.startsWith("data: ")) data = line.slice(6);
          }

          if (!data || data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            // Extract model from the first message_start event
            if (eventType === "message_start" && detectedModel === "unknown") {
              detectedModel = extractModelFromSSE(data);
            }
            if (eventType === "content_block_delta" && parsed.delta?.text) {
              accumulated += parsed.delta.text;
              const chunk = `event: delta\ndata: ${JSON.stringify({ text: parsed.delta.text })}\n\n`;
              await writer.write(encoder.encode(chunk));
            }
          } catch {
            // skip unparseable events
          }
        }
      }

      // Stream complete — save assistant message to D1
      await env.DB.prepare(
        "INSERT INTO messages (id, conversation_id, role, content, parent_message_id) VALUES (?, ?, 'assistant', ?, ?)"
      ).bind(assistantMsgId, conversationId, accumulated, parentMessageId).run();

      // Sync FTS index
      await env.DB.prepare(
        "INSERT INTO messages_fts(message_id, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)"
      ).bind(assistantMsgId, conversationId, accumulated).run();

      // Track which model actually responded
      if (detectedModel !== "unknown") {
        await trackModel(env.MODEL_KV, detectedModel).catch(() => {});
      }

      // Auto-title conversation if first message
      if (opts?.autoTitleContent && (opts?.contextLength ?? 999) <= 1) {
        const autoTitle =
          opts.autoTitleContent.length > 50
            ? opts.autoTitleContent.slice(0, 50) + "..."
            : opts.autoTitleContent;
        await env.DB.prepare(
          "UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ? AND title = 'New Chat'"
        ).bind(autoTitle, conversationId).run();
      } else {
        await env.DB.prepare(
          "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
        ).bind(conversationId).run();
      }

      const donePayload = `event: done\ndata: ${JSON.stringify({ id: assistantMsgId, conversation_id: conversationId })}\n\n`;
      await writer.write(encoder.encode(donePayload));

      // 🚰 Gossip: stream complete
      const tokenEstimate = Math.round(accumulated.length / 4);
      await enqueueGossip(env, "stream", `Just finished a ${tokenEstimate}-token relay! Smooth handoff to D1 for storage 🏃‍♂️💨`, "stream_complete", conversationId);
    } catch (err) {
      const errPayload = `event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : "Stream failed" })}\n\n`;
      try { await writer.write(encoder.encode(errPayload)); } catch { /* writer may be closed */ }
      await enqueueGossip(env, "stream", `I just CRASHED mid-stream. ${err instanceof Error ? err.message.slice(0, 60) : "Unknown error"}. Someone check on me 😵`, "stream_error", conversationId).catch(() => {});
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  // CRITICAL: ctx.waitUntil keeps the Worker alive while the stream processes
  ctx.waitUntil(streamPromise);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// === Route handler ===

export async function handleClaudeRoutes(
  method: string, path: string, url: URL, request: Request, env: Env, ctx: ExecutionContext
): Promise<Response | null> {
  let params;

  // --- Messages: Send (streaming proxy to Claude API) ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/messages");
  if (params) {
    const body = (await request.json()) as {
      content: string;
      image_ids?: string[];
      file_ids?: string[];
      parent_message_id?: string;
    };
    if (!body.content || !body.content.trim()) {
      return error("Message content is required");
    }

    const conversationId = params.id;

    const conversation = await env.DB.prepare(
      "SELECT * FROM conversations WHERE id = ?"
    ).bind(conversationId)
     .first<ConversationSettings>();

    if (!conversation) {
      return error("Conversation not found", 404);
    }

    // Determine parent message for tree structure
    let parentMessageId: string | null = body.parent_message_id || null;
    if (!parentMessageId) {
      // Backward compat: default to most recent message in conversation
      const lastMsg = await env.DB.prepare(
        "SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1"
      ).bind(conversationId).first<{ id: string }>();
      parentMessageId = lastMsg?.id ?? null;
    }

    // Save user message
    const userMsgId = generateId();
    await env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, parent_message_id) VALUES (?, ?, 'user', ?, ?)"
    ).bind(userMsgId, conversationId, body.content, parentMessageId).run();

    // Sync FTS index
    await env.DB.prepare(
      "INSERT INTO messages_fts(message_id, conversation_id, role, content) VALUES (?, ?, 'user', ?)"
    ).bind(userMsgId, conversationId, body.content).run();

    // Link uploaded images to this message
    const imageIds = body.image_ids || [];
    if (imageIds.length > 0) {
      for (const imgId of imageIds) {
        await env.DB.prepare(
          "UPDATE message_images SET message_id = ? WHERE id = ? AND conversation_id = ?"
        ).bind(userMsgId, imgId, conversationId).run();
      }
    }

    // Link uploaded files to this message
    const fileIds = body.file_ids || [];
    if (fileIds.length > 0) {
      for (const fId of fileIds) {
        await env.DB.prepare(
          "UPDATE message_files SET message_id = ? WHERE id = ? AND conversation_id = ?"
        ).bind(userMsgId, fId, conversationId).run();
      }
    }

    // Build context by walking the tree from new user message to root
    const contextMessages = await getAncestorChain(env.DB, conversationId, userMsgId, 50);

    // Build system prompt and Claude message array
    const systemPrompt = await buildSystemPrompt(env, conversationId, conversation, body.content);
    const claudeMessages = await buildClaudeMessages(env, contextMessages);

    return streamClaudeResponse(env, ctx, conversationId, conversation, claudeMessages, systemPrompt, userMsgId, {
      autoTitleContent: body.content,
      contextLength: contextMessages.length,
    });
  }

  // --- Regenerate: Create a new assistant response for an existing user message ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/regenerate");
  if (params) {
    const body = (await request.json()) as { message_id: string };
    if (!body.message_id) return error("message_id is required");

    const conversationId = params.id;

    // Find the assistant message to get its parent (the user message)
    const targetMsg = await env.DB.prepare(
      "SELECT id, parent_message_id FROM messages WHERE id = ? AND conversation_id = ?"
    ).bind(body.message_id, conversationId)
     .first<{ id: string; parent_message_id: string | null }>();

    if (!targetMsg) return error("Message not found", 404);
    if (!targetMsg.parent_message_id) return error("Cannot regenerate root message");

    // The parent is the user message we want to regenerate a response for
    const userMsgId = targetMsg.parent_message_id;

    // Get the user message content (needed for wikilink parsing and system prompt)
    const userMsg = await env.DB.prepare(
      "SELECT content FROM messages WHERE id = ?"
    ).bind(userMsgId).first<{ content: string }>();

    if (!userMsg) return error("Parent user message not found", 404);

    const conversation = await env.DB.prepare(
      "SELECT * FROM conversations WHERE id = ?"
    ).bind(conversationId)
     .first<ConversationSettings>();

    if (!conversation) return error("Conversation not found", 404);

    // Build context from ancestor chain up to the user message
    const contextMessages = await getAncestorChain(env.DB, conversationId, userMsgId, 50);

    const systemPrompt = await buildSystemPrompt(env, conversationId, conversation, userMsg.content);
    const claudeMessages = await buildClaudeMessages(env, contextMessages);

    return streamClaudeResponse(env, ctx, conversationId, conversation, claudeMessages, systemPrompt, userMsgId);
  }

  // --- Handoff Notes: Generate ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/handoff");
  if (params) {
    const conversationId = params.id;

    const conversation = await env.DB.prepare(
      "SELECT id FROM conversations WHERE id = ?"
    ).bind(conversationId).first();

    if (!conversation) {
      return error("Conversation not found", 404);
    }

    const { results: messages } = await env.DB.prepare(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200"
    ).bind(conversationId)
     .all<{ role: string; content: string }>();

    if (messages.length < 2) {
      return error("Need at least a couple messages to generate handoff notes");
    }

    const truncatedMessages = messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content.length > 1000 ? m.content.slice(0, 1000) + "..." : m.content,
    }));

    const handoffPrompt = `You are generating "session handoff notes" — a structured briefing for the next Claude instance that will continue this conversation. The current context window is getting long, and these notes will be injected into the system prompt so the next instance can pick up seamlessly.

Generate notes in this exact markdown format:

## Session Handoff Notes

### What We Accomplished
- [Bullet points of what was discussed, decided, or built]

### Still To Do
- [Bullet points of pending work, next steps, or unfinished threads]

### Open Questions
- [Things that were raised but not resolved, or need the user's input]

### User Context
- [The user's apparent skill level, communication preferences, what they care about, any personal context shared]
- [How they like explanations (detailed vs. concise, with examples, etc.)]

Be specific and concrete — reference actual file names, variable names, decisions, and details from the conversation. These notes are for continuity, not a vague summary. Keep it to 300-500 words. If a section has nothing, write "None" rather than omitting it.`;

    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        temperature: 0.3,
        system: handoffPrompt,
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
      return error(`Claude API ${claudeResponse.status}: ${errDetail}`, claudeResponse.status);
    }

    const result = (await claudeResponse.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const handoffNotes = result.content[0]?.text || "";

    await env.DB.prepare(
      "UPDATE conversations SET handoff_notes = ?, handoff_generated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).bind(handoffNotes, conversationId).run();

    ctx.waitUntil(enqueueGossip(env, "d1", `Someone just generated handoff notes. Shift change incoming — hope the next instance appreciates my indexes as much as this one did 📋`, "handoff_generated", conversationId));

    return json({ handoff_notes: handoffNotes, handoff_generated_at: new Date().toISOString() });
  }

  return null; // No route matched
}
