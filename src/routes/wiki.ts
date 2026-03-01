import type { Env } from "../types";
import { generateId, slugify, json, error, matchRoute } from "../utils";
import { generateWikiPages } from "../wikigen";

// All wiki routes: categories, pages, upload, page tags, conversation pins
export async function handleWikiRoutes(
  method: string, path: string, url: URL, request: Request, env: Env, ctx: ExecutionContext
): Promise<Response | null> {
  let params;

  // --- Wiki Categories: List ---
  params = matchRoute(method, path, "GET", "/api/wiki/categories");
  if (params) {
    const { results } = await env.DB.prepare(
      `SELECT wc.*, COUNT(wp.id) as page_count
       FROM wiki_categories wc LEFT JOIN wiki_pages wp ON wp.category_id = wc.id
       GROUP BY wc.id ORDER BY wc.sort_order, wc.name`
    ).all();
    return json(results);
  }

  // --- Wiki Categories: Create ---
  params = matchRoute(method, path, "POST", "/api/wiki/categories");
  if (params) {
    const body = (await request.json()) as { name: string; description?: string; icon?: string };
    if (!body.name?.trim()) return error("Category name is required");
    const id = generateId();
    await env.DB.prepare(
      "INSERT INTO wiki_categories (id, name, description, icon) VALUES (?, ?, ?, ?)"
    ).bind(id, body.name.trim(), body.description || null, body.icon || null).run();
    return json({ id, name: body.name.trim(), description: body.description || null, icon: body.icon || null, sort_order: 0 }, 201);
  }

  // --- Wiki Categories: Update ---
  params = matchRoute(method, path, "PUT", "/api/wiki/categories/:id");
  if (params) {
    const body = (await request.json()) as { name?: string; description?: string; icon?: string; sort_order?: number };
    const updates: string[] = [];
    const values: any[] = [];
    if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name.trim()); }
    if (body.description !== undefined) { updates.push("description = ?"); values.push(body.description); }
    if (body.icon !== undefined) { updates.push("icon = ?"); values.push(body.icon); }
    if (body.sort_order !== undefined) { updates.push("sort_order = ?"); values.push(body.sort_order); }
    updates.push("updated_at = datetime('now')");
    await env.DB.prepare(
      `UPDATE wiki_categories SET ${updates.join(", ")} WHERE id = ?`
    ).bind(...values, params.id).run();
    return json({ ok: true });
  }

  // --- Wiki Categories: Delete ---
  params = matchRoute(method, path, "DELETE", "/api/wiki/categories/:id");
  if (params) {
    await env.DB.prepare("DELETE FROM wiki_categories WHERE id = ?").bind(params.id).run();
    return json({ ok: true });
  }

  // --- Wiki Pages: List ---
  params = matchRoute(method, path, "GET", "/api/wiki/pages");
  if (params) {
    const categoryId = url.searchParams.get("category_id");

    let query = `SELECT wp.id, wp.title, wp.slug, wp.summary, wp.source_url, wp.category_id,
      wc.name as category_name, wc.icon as category_icon, wp.created_at, wp.updated_at
      FROM wiki_pages wp LEFT JOIN wiki_categories wc ON wp.category_id = wc.id`;
    const bindings: string[] = [];
    if (categoryId) {
      query += " WHERE wp.category_id = ?";
      bindings.push(categoryId);
    }
    query += " ORDER BY wp.updated_at DESC";

    const { results: pages } = await env.DB.prepare(query).bind(...bindings).all();

    // Batch-fetch tags
    const { results: allTags } = await env.DB.prepare(
      `SELECT wpt.page_id, t.id, t.name, t.color
       FROM wiki_page_tags wpt JOIN tags t ON wpt.tag_id = t.id`
    ).all();
    const tagsByPage = new Map<string, any[]>();
    for (const t of allTags) {
      const arr = tagsByPage.get(t.page_id as string) || [];
      arr.push({ id: t.id, name: t.name, color: t.color });
      tagsByPage.set(t.page_id as string, arr);
    }

    const enriched = pages.map((p: any) => ({ ...p, tags: tagsByPage.get(p.id) || [] }));
    return json(enriched);
  }

  // --- Wiki Pages: Get single ---
  params = matchRoute(method, path, "GET", "/api/wiki/pages/:id");
  if (params) {
    const page = await env.DB.prepare(
      `SELECT wp.*, wc.name as category_name, wc.icon as category_icon
       FROM wiki_pages wp LEFT JOIN wiki_categories wc ON wp.category_id = wc.id
       WHERE wp.id = ?`
    ).bind(params.id).first();
    if (!page) return error("Page not found", 404);

    const { results: tags } = await env.DB.prepare(
      "SELECT t.id, t.name, t.color FROM wiki_page_tags wpt JOIN tags t ON wpt.tag_id = t.id WHERE wpt.page_id = ?"
    ).bind(params.id).all();

    // Backlinks: find pages whose content contains [[This Page Title]] or [[this-page-slug]]
    // Uses SQLite LIKE with || for string concat — scans at the DB level, not in JS
    const { results: backlinks } = await env.DB.prepare(
      `SELECT id, title, slug, summary, updated_at FROM wiki_pages
       WHERE id != ? AND (
         content LIKE '%[[' || ? || ']]%'
         OR content LIKE '%[[' || ? || ']]%'
       )
       ORDER BY updated_at DESC LIMIT 20`
    ).bind(params.id, page.title, page.slug).all();

    return json({ ...page, tags, backlinks });
  }

  // --- Wiki Pages: Upload (.md file) ---
  // IMPORTANT: This route MUST come before POST /api/wiki/pages/:id to avoid matching as :id = "upload"
  params = matchRoute(method, path, "POST", "/api/wiki/pages/upload");
  if (params) {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) return error("No file provided");
    const name = file.name || "untitled.md";
    if (!name.endsWith(".md") && file.type !== "text/markdown") return error("Only .md files are accepted");

    const content = await file.text();
    const categoryId = formData.get("category_id") as string | null;

    // Extract title from first # heading or filename
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const title = headingMatch ? headingMatch[1].trim() : name.replace(/\.md$/i, "");

    // Auto-generate summary
    const plainText = content.replace(/^#+\s+.*$/gm, "").replace(/[*_`~\[\]()>]/g, "").trim();
    const summary = plainText.length > 200 ? plainText.slice(0, 200) + "..." : plainText;

    // Generate unique slug
    let slug = slugify(title);
    let suffix = 0;
    while (true) {
      const candidateSlug = suffix === 0 ? slug : `${slug}-${suffix}`;
      const existing = await env.DB.prepare("SELECT id FROM wiki_pages WHERE slug = ?").bind(candidateSlug).first();
      if (!existing) { slug = candidateSlug; break; }
      suffix++;
    }

    const id = generateId();
    await env.DB.prepare(
      "INSERT INTO wiki_pages (id, category_id, title, slug, content, summary) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, categoryId || null, title, slug, content, summary).run();

    // Sync FTS
    await env.DB.prepare(
      "INSERT INTO wiki_fts(page_id, title, content) VALUES (?, ?, ?)"
    ).bind(id, title, content).run();

    const page = await env.DB.prepare("SELECT * FROM wiki_pages WHERE id = ?").bind(id).first();
    return json(page, 201);
  }

  // --- Wiki Pages: Create ---
  params = matchRoute(method, path, "POST", "/api/wiki/pages");
  if (params) {
    const body = (await request.json()) as {
      title: string; content?: string; summary?: string;
      category_id?: string; source_url?: string; tags?: string[];
    };
    if (!body.title?.trim()) return error("Title is required");

    const title = body.title.trim();
    const content = body.content || "";
    const summary = body.summary || "";

    // Generate unique slug
    let slug = slugify(title);
    let suffix = 0;
    while (true) {
      const candidateSlug = suffix === 0 ? slug : `${slug}-${suffix}`;
      const existing = await env.DB.prepare("SELECT id FROM wiki_pages WHERE slug = ?").bind(candidateSlug).first();
      if (!existing) { slug = candidateSlug; break; }
      suffix++;
    }

    const id = generateId();
    await env.DB.prepare(
      "INSERT INTO wiki_pages (id, category_id, title, slug, content, summary, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, body.category_id || null, title, slug, content, summary, body.source_url || null).run();

    // Sync FTS
    await env.DB.prepare(
      "INSERT INTO wiki_fts(page_id, title, content) VALUES (?, ?, ?)"
    ).bind(id, title, content).run();

    // Handle tags
    if (body.tags && body.tags.length > 0) {
      for (const tagName of body.tags) {
        const name = tagName.trim().toLowerCase();
        let existing = await env.DB.prepare("SELECT id FROM tags WHERE name = ?").bind(name).first<{ id: string }>();
        if (!existing) {
          const tagId = generateId();
          await env.DB.prepare("INSERT INTO tags (id, name) VALUES (?, ?)").bind(tagId, name).run();
          existing = { id: tagId };
        }
        await env.DB.prepare(
          "INSERT OR IGNORE INTO wiki_page_tags (page_id, tag_id) VALUES (?, ?)"
        ).bind(id, existing.id).run();
      }
    }

    const page = await env.DB.prepare("SELECT * FROM wiki_pages WHERE id = ?").bind(id).first();
    return json(page, 201);
  }

  // --- Wiki Pages: Update ---
  params = matchRoute(method, path, "PUT", "/api/wiki/pages/:id");
  if (params) {
    const body = (await request.json()) as {
      title?: string; content?: string; summary?: string;
      category_id?: string; source_url?: string;
    };

    // Snapshot current content before updating (for version history)
    if (body.content !== undefined) {
      const current = await env.DB.prepare(
        "SELECT title, content FROM wiki_pages WHERE id = ?"
      ).bind(params.id).first<{ title: string; content: string }>();

      if (current && body.content !== current.content) {
        ctx.waitUntil(env.JOBS.send({
          type: "wiki_snapshot",
          pageId: params.id,
          title: current.title,
          content: current.content,
          editedAt: new Date().toISOString(),
        }));
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    if (body.title !== undefined) {
      updates.push("title = ?");
      values.push(body.title.trim());
      // Regenerate slug
      let slug = slugify(body.title.trim());
      let suffix = 0;
      while (true) {
        const candidateSlug = suffix === 0 ? slug : `${slug}-${suffix}`;
        const existing = await env.DB.prepare("SELECT id FROM wiki_pages WHERE slug = ? AND id != ?").bind(candidateSlug, params.id).first();
        if (!existing) { slug = candidateSlug; break; }
        suffix++;
      }
      updates.push("slug = ?");
      values.push(slug);
    }
    if (body.content !== undefined) { updates.push("content = ?"); values.push(body.content); }
    if (body.summary !== undefined) { updates.push("summary = ?"); values.push(body.summary); }
    if (body.category_id !== undefined) { updates.push("category_id = ?"); values.push(body.category_id || null); }
    if (body.source_url !== undefined) { updates.push("source_url = ?"); values.push(body.source_url || null); }
    updates.push("updated_at = datetime('now')");

    if (updates.length > 1) {
      await env.DB.prepare(
        `UPDATE wiki_pages SET ${updates.join(", ")} WHERE id = ?`
      ).bind(...values, params.id).run();
    }

    // FTS sync: delete + re-insert
    const page = await env.DB.prepare("SELECT title, content FROM wiki_pages WHERE id = ?").bind(params.id).first<{ title: string; content: string }>();
    if (page) {
      await env.DB.prepare("DELETE FROM wiki_fts WHERE page_id = ?").bind(params.id).run();
      await env.DB.prepare(
        "INSERT INTO wiki_fts(page_id, title, content) VALUES (?, ?, ?)"
      ).bind(params.id, page.title, page.content).run();
    }

    return json({ ok: true });
  }

  // --- Wiki Page Versions: List ---
  params = matchRoute(method, path, "GET", "/api/wiki/pages/:id/versions");
  if (params) {
    const { results } = await env.DB.prepare(
      "SELECT id, version_number, title, size_bytes, created_at FROM wiki_page_versions WHERE page_id = ? ORDER BY version_number DESC"
    ).bind(params.id).all();
    return json(results);
  }

  // --- Wiki Page Versions: Get content ---
  params = matchRoute(method, path, "GET", "/api/wiki/versions/:id");
  if (params) {
    const version = await env.DB.prepare(
      "SELECT id, page_id, version_number, title, r2_key, created_at FROM wiki_page_versions WHERE id = ?"
    ).bind(params.id).first<{ id: string; page_id: string; version_number: number; title: string; r2_key: string; created_at: string }>();

    if (!version) return error("Version not found", 404);

    const obj = await env.FILES.get(version.r2_key);
    if (!obj) return error("Version content missing from storage", 404);

    const content = await obj.text();
    return json({ ...version, content });
  }

  // --- Wiki Page Versions: Restore ---
  params = matchRoute(method, path, "POST", "/api/wiki/versions/:id/restore");
  if (params) {
    const version = await env.DB.prepare(
      "SELECT page_id, title, r2_key FROM wiki_page_versions WHERE id = ?"
    ).bind(params.id).first<{ page_id: string; title: string; r2_key: string }>();

    if (!version) return error("Version not found", 404);

    const obj = await env.FILES.get(version.r2_key);
    if (!obj) return error("Version content missing from storage", 404);

    const content = await obj.text();

    // Snapshot the current content before restoring
    const current = await env.DB.prepare(
      "SELECT title, content FROM wiki_pages WHERE id = ?"
    ).bind(version.page_id).first<{ title: string; content: string }>();

    if (current) {
      ctx.waitUntil(env.JOBS.send({
        type: "wiki_snapshot",
        pageId: version.page_id,
        title: current.title,
        content: current.content,
        editedAt: new Date().toISOString(),
      }));
    }

    // Restore the version content
    await env.DB.prepare(
      "UPDATE wiki_pages SET content = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(content, version.page_id).run();

    // FTS sync
    const page = await env.DB.prepare("SELECT title FROM wiki_pages WHERE id = ?").bind(version.page_id).first<{ title: string }>();
    if (page) {
      await env.DB.prepare("DELETE FROM wiki_fts WHERE page_id = ?").bind(version.page_id).run();
      await env.DB.prepare(
        "INSERT INTO wiki_fts(page_id, title, content) VALUES (?, ?, ?)"
      ).bind(version.page_id, page.title, content).run();
    }

    return json({ ok: true, restored_version: params.id });
  }

  // --- Wiki Pages: Delete ---
  params = matchRoute(method, path, "DELETE", "/api/wiki/pages/:id");
  if (params) {
    // Collect R2 keys from versions BEFORE cascade delete orphans them
    const { results: versionRows } = await env.DB.prepare(
      "SELECT r2_key FROM wiki_page_versions WHERE page_id = ?"
    ).bind(params.id).all<{ r2_key: string }>();

    await env.DB.prepare("DELETE FROM wiki_fts WHERE page_id = ?").bind(params.id).run();
    await env.DB.prepare("DELETE FROM wiki_pages WHERE id = ?").bind(params.id).run();

    // Clean up R2 version objects (fire-and-forget)
    if (versionRows.length > 0) {
      const r2Keys = versionRows.map(r => r.r2_key);
      ctx.waitUntil(env.FILES.delete(r2Keys));
    }

    return json({ ok: true });
  }

  // --- Wiki Page Tags: Add ---
  params = matchRoute(method, path, "POST", "/api/wiki/pages/:id/tags");
  if (params) {
    const body = (await request.json()) as { tag_id?: string; name?: string; color?: string };
    let tagId = body.tag_id;
    if (!tagId && body.name) {
      const name = body.name.trim().toLowerCase();
      const existing = await env.DB.prepare("SELECT id FROM tags WHERE name = ?").bind(name).first<{ id: string }>();
      if (existing) {
        tagId = existing.id;
      } else {
        tagId = generateId();
        await env.DB.prepare("INSERT INTO tags (id, name, color) VALUES (?, ?, ?)").bind(tagId, name, body.color || null).run();
      }
    }
    if (!tagId) return error("tag_id or name is required");
    await env.DB.prepare("INSERT OR IGNORE INTO wiki_page_tags (page_id, tag_id) VALUES (?, ?)").bind(params.id, tagId).run();
    const tag = await env.DB.prepare("SELECT * FROM tags WHERE id = ?").bind(tagId).first();
    return json(tag, 201);
  }

  // --- Wiki Page Tags: Remove ---
  params = matchRoute(method, path, "DELETE", "/api/wiki/pages/:id/tags/:tagId");
  if (params) {
    await env.DB.prepare("DELETE FROM wiki_page_tags WHERE page_id = ? AND tag_id = ?").bind(params.id, params.tagId).run();
    return json({ ok: true });
  }

  // --- Conversation Wiki Pins: List ---
  params = matchRoute(method, path, "GET", "/api/conversations/:id/wiki-pins");
  if (params) {
    const { results } = await env.DB.prepare(
      `SELECT wp.id, wp.title, wp.slug, wp.summary, wp.updated_at
       FROM conversation_wiki_pins cwp JOIN wiki_pages wp ON cwp.page_id = wp.id
       WHERE cwp.conversation_id = ? ORDER BY cwp.created_at ASC`
    ).bind(params.id).all();
    return json(results);
  }

  // --- Conversation Wiki Pins: Add ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/wiki-pins");
  if (params) {
    const body = (await request.json()) as { page_id: string };
    if (!body.page_id) return error("page_id is required");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO conversation_wiki_pins (conversation_id, page_id) VALUES (?, ?)"
    ).bind(params.id, body.page_id).run();
    return json({ ok: true }, 201);
  }

  // --- Conversation Wiki Pins: Remove ---
  params = matchRoute(method, path, "DELETE", "/api/conversations/:id/wiki-pins/:pageId");
  if (params) {
    await env.DB.prepare(
      "DELETE FROM conversation_wiki_pins WHERE conversation_id = ? AND page_id = ?"
    ).bind(params.id, params.pageId).run();
    return json({ ok: true });
  }

  // --- Generate Wiki Pages from Conversation ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/generate-wiki");
  if (params) {
    try {
      const proposals = await generateWikiPages(env, params.id);
      return json(proposals);
    } catch (e: any) {
      return error(e.message);
    }
  }

  // --- Batch Create Wiki Pages ---
  params = matchRoute(method, path, "POST", "/api/wiki/pages/batch");
  if (params) {
    const body = (await request.json()) as {
      pages: Array<{
        title: string; content: string; summary?: string;
        category_name?: string | null; tags?: string[];
      }>;
      conversation_id?: string;
    };

    if (!body.pages || !Array.isArray(body.pages) || body.pages.length === 0) {
      return error("At least one page is required");
    }

    const createdPages: Array<{ id: string; title: string; slug: string }> = [];

    for (const page of body.pages) {
      if (!page.title?.trim()) continue;

      const title = page.title.trim();
      const content = page.content || "";
      const summary = page.summary || "";

      // Resolve category by name
      let categoryId: string | null = null;
      if (page.category_name) {
        const cat = await env.DB.prepare(
          "SELECT id FROM wiki_categories WHERE name = ?"
        ).bind(page.category_name).first<{ id: string }>();
        categoryId = cat?.id || null;
      }

      // Generate unique slug
      let slug = slugify(title);
      let suffix = 0;
      while (true) {
        const candidateSlug = suffix === 0 ? slug : `${slug}-${suffix}`;
        const existing = await env.DB.prepare(
          "SELECT id FROM wiki_pages WHERE slug = ?"
        ).bind(candidateSlug).first();
        if (!existing) { slug = candidateSlug; break; }
        suffix++;
      }

      const id = generateId();
      await env.DB.prepare(
        "INSERT INTO wiki_pages (id, category_id, title, slug, content, summary) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, categoryId, title, slug, content, summary).run();

      // Sync FTS
      await env.DB.prepare(
        "INSERT INTO wiki_fts(page_id, title, content) VALUES (?, ?, ?)"
      ).bind(id, title, content).run();

      // Handle tags
      if (page.tags && page.tags.length > 0) {
        for (const tagName of page.tags) {
          const name = tagName.trim().toLowerCase();
          if (!name) continue;
          let existing = await env.DB.prepare(
            "SELECT id FROM tags WHERE name = ?"
          ).bind(name).first<{ id: string }>();
          if (!existing) {
            const tagId = generateId();
            await env.DB.prepare(
              "INSERT INTO tags (id, name) VALUES (?, ?)"
            ).bind(tagId, name).run();
            existing = { id: tagId };
          }
          await env.DB.prepare(
            "INSERT OR IGNORE INTO wiki_page_tags (page_id, tag_id) VALUES (?, ?)"
          ).bind(id, existing.id).run();
        }
      }

      // Track generation source
      if (body.conversation_id) {
        await env.DB.prepare(
          "INSERT INTO conversation_wiki_generations (id, conversation_id, page_id) VALUES (?, ?, ?)"
        ).bind(generateId(), body.conversation_id, id).run();
      }

      createdPages.push({ id, title, slug });
    }

    return json(createdPages, 201);
  }

  return null; // No route matched
}
