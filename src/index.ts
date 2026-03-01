import type { Env, QueueJob } from "./types";
import { error } from "./utils";
import { handleLogin, authenticate } from "./auth";
import { handleImageServe, handleConversationRoutes } from "./routes/conversations";
import { handleClaudeRoutes } from "./routes/claude";
import { handleWikiRoutes } from "./routes/wiki";
import { handleTagRoutes } from "./routes/tags";
import { handleSearchRoutes } from "./routes/search";
import { handleGossipRoutes } from "./routes/gossip";
import { handleTTSRoutes } from "./routes/tts";
import { handleFileRoutes, handleFileServe } from "./routes/files";
import { handleExportRoutes } from "./routes/exports";
import { handleArchiveRoutes } from "./routes/archive";
import { handleQueue } from "./queue";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // Only handle /api routes — everything else is served as static assets by Cloudflare
      if (!path.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      // --- Pre-auth routes ---

      // Image serving (no auth — images are immutable, keyed by UUID)
      const imageResponse = await handleImageServe(method, path, env);
      if (imageResponse) return imageResponse;

      // File serving (no auth — files are immutable, keyed by UUID)
      const fileResponse = await handleFileServe(method, path, env);
      if (fileResponse) return fileResponse;

      // Auth login
      if (method === "POST" && path === "/api/auth/login") {
        return handleLogin(request, env);
      }

      // --- Auth middleware for all other /api routes ---
      const authError = await authenticate(request, env);
      if (authError) return authError;

      // --- Authenticated routes ---
      // Order matters: specific routes before parameterized ones.
      // Each handler returns Response if matched, null if not.
      const response = await handleConversationRoutes(method, path, url, request, env, ctx)
        ?? await handleTagRoutes(method, path, url, request, env)
        ?? await handleSearchRoutes(method, path, url, request, env)
        ?? await handleWikiRoutes(method, path, url, request, env, ctx)
        ?? await handleClaudeRoutes(method, path, url, request, env, ctx)
        ?? await handleGossipRoutes(method, path, url, request, env)
        ?? await handleTTSRoutes(method, path, url, request, env)
        ?? await handleFileRoutes(method, path, url, request, env, ctx)
        ?? await handleArchiveRoutes(method, path, url, request, env)
        ?? await handleExportRoutes(method, path, url, request, env);

      return response ?? error("Not found", 404);
    } catch (e: any) {
      return new Response(JSON.stringify({ error: `Internal error: ${e.message}` }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (event.cron === "0 */6 * * *") {
      // Every 6 hours: summarize conversations + water cooler chat
      await env.JOBS.sendBatch([
        { body: { type: "summarize_batch" } },
        { body: { type: "water_cooler" } },
      ]);
    } else if (event.cron === "0 3 * * *") {
      // Daily at 3AM UTC: backup database + auto-archive old conversations
      await env.JOBS.sendBatch([
        { body: { type: "database_backup" } },
        { body: { type: "archive_batch" } },
      ]);
    }
  },

  async queue(batch: MessageBatch<QueueJob>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
};
