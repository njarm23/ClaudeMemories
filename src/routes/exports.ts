import type { Env } from "../types";
import { json, error, matchRoute } from "../utils";
import { exportConversation } from "../export";

export async function handleExportRoutes(
  method: string, path: string, url: URL, request: Request, env: Env
): Promise<Response | null> {
  let params;

  // --- Export: Trigger ---
  params = matchRoute(method, path, "POST", "/api/conversations/:id/export");
  if (params) {
    const body = (await request.json()) as { format?: "markdown" | "json" };
    const format = body.format === "json" ? "json" : "markdown";

    try {
      const { r2Key, size } = await exportConversation(env, params.id, format);
      return json({
        download_url: `/api/exports/${encodeURIComponent(r2Key)}`,
        format,
        size,
      });
    } catch (e: any) {
      return error(`Export failed: ${e.message}`, 500);
    }
  }

  // --- Export: Download ---
  // Path: /api/exports/exports/{conversationId}/{timestamp}.{ext}
  // We match a wildcard pattern manually since matchRoute doesn't support wildcards
  if (method === "GET" && path.startsWith("/api/exports/")) {
    const r2Key = decodeURIComponent(path.slice("/api/exports/".length));
    if (!r2Key || !r2Key.startsWith("exports/")) {
      return error("Invalid export path", 400);
    }

    const obj = await env.FILES.get(r2Key);
    if (!obj) return error("Export not found", 404);

    const isJson = r2Key.endsWith(".json");
    const filename = r2Key.split("/").pop() || "export";

    return new Response(obj.body, {
      headers: {
        "Content-Type": isJson ? "application/json" : "text/markdown",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return null;
}
