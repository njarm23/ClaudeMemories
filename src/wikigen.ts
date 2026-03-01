import type { Env } from "./types";

export interface WikiPageProposal {
  title: string;
  content: string;
  summary: string;
  category_name: string | null;
  tags: string[];
  rationale: string;
}

export async function generateWikiPages(env: Env, conversationId: string): Promise<WikiPageProposal[]> {
  // 1. Fetch conversation messages (up to 200, truncated)
  const { results: messages } = await env.DB.prepare(
    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200"
  ).bind(conversationId).all<{ role: string; content: string }>();

  if (messages.length < 2) {
    throw new Error("Not enough messages to generate wiki pages");
  }

  // 2. Fetch existing wiki page titles + summaries (deduplication context)
  const { results: existingPages } = await env.DB.prepare(
    "SELECT title, summary FROM wiki_pages ORDER BY updated_at DESC LIMIT 100"
  ).all<{ title: string; summary: string | null }>();

  // 3. Fetch existing categories
  const { results: categories } = await env.DB.prepare(
    "SELECT name, icon FROM wiki_categories ORDER BY sort_order, name"
  ).all<{ name: string; icon: string | null }>();

  // 4. Fetch existing tags
  const { results: tags } = await env.DB.prepare(
    "SELECT name FROM tags ORDER BY name LIMIT 50"
  ).all<{ name: string }>();

  // 5. Check previously generated pages from this conversation
  const { results: previousGens } = await env.DB.prepare(
    `SELECT wp.title FROM conversation_wiki_generations cwg
     JOIN wiki_pages wp ON cwg.page_id = wp.id
     WHERE cwg.conversation_id = ?`
  ).bind(conversationId).all<{ title: string }>();

  // Truncate messages to save tokens
  const truncated = messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content.length > 1000 ? m.content.slice(0, 1000) + "..." : m.content,
  }));

  const existingPagesContext = existingPages.length > 0
    ? `\nExisting wiki pages (DO NOT duplicate these topics):\n${existingPages.map((p) => `- "${p.title}"${p.summary ? `: ${p.summary}` : ""}`).join("\n")}`
    : "";

  const categoriesContext = categories.length > 0
    ? `\nExisting categories (suggest from these when applicable):\n${categories.map((c) => `- ${c.icon || "📁"} ${c.name}`).join("\n")}`
    : "";

  const tagsContext = tags.length > 0
    ? `\nExisting tags (suggest from these when applicable): ${tags.map((t) => t.name).join(", ")}`
    : "";

  const previousContext = previousGens.length > 0
    ? `\nPages already generated from this conversation (DO NOT re-propose):\n${previousGens.map((p) => `- "${p.title}"`).join("\n")}`
    : "";

  const systemPrompt = `You are a knowledge curator. Analyze the conversation and identify 1-3 distinct topics worthy of standalone wiki pages. Each page should:
- Be self-contained (not conversational — write as a reference article)
- Be 200-800 words in Markdown format
- Cover a specific concept, technique, decision, or piece of knowledge discussed
- Be useful as future reference material

${existingPagesContext}${categoriesContext}${tagsContext}${previousContext}

Return ONLY a JSON array of page proposals. Each object must have:
- "title": Clear, concise page title
- "content": Full Markdown content for the page
- "summary": 1-2 sentence summary
- "category_name": Suggested category name (from existing list or null)
- "tags": Array of 1-3 tag names (prefer existing tags)
- "rationale": Brief explanation of why this topic deserves a wiki page

If the conversation doesn't contain wiki-worthy knowledge, return an empty array [].
Do NOT wrap the JSON in code fences.`;

  const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      temperature: 0.3,
      system: systemPrompt,
      messages: [...truncated, { role: "user" as const, content: "Analyze this conversation and propose wiki pages." }],
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
    throw new Error(`Claude API ${claudeResponse.status}: ${errDetail}`);
  }

  const result = (await claudeResponse.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const responseText = result.content[0]?.text || "";

  try {
    const cleanJson = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const proposals = JSON.parse(cleanJson) as WikiPageProposal[];

    if (!Array.isArray(proposals)) {
      throw new Error("Response is not an array");
    }

    // Validate each proposal
    return proposals.filter(
      (p) => p.title && p.content && typeof p.title === "string" && typeof p.content === "string"
    );
  } catch (err) {
    console.error("Failed to parse wiki generation response:", responseText.slice(0, 200));
    throw new Error("Failed to parse Claude's wiki page proposals");
  }
}
