// Allowed image types for Claude vision API
export const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

export function extFromMediaType(type: string): string {
  const map: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  return map[type] || "bin";
}

// --- File attachment support ---
// How Claude can process different file types
export type ClaudeFileSupport = "native" | "text" | "none";

interface FileTypeConfig {
  maxSize: number;
  claudeSupport: ClaudeFileSupport;
}

// Files Claude can process natively or as text
const FILE_TYPE_MAP = new Map<string, FileTypeConfig>([
  // Documents Claude handles natively
  ["application/pdf", { maxSize: 10 * 1024 * 1024, claudeSupport: "native" }],
  // Text/data files — sent as text content
  ["text/plain", { maxSize: 1 * 1024 * 1024, claudeSupport: "text" }],
  ["text/markdown", { maxSize: 1 * 1024 * 1024, claudeSupport: "text" }],
  ["text/csv", { maxSize: 2 * 1024 * 1024, claudeSupport: "text" }],
  ["text/html", { maxSize: 1 * 1024 * 1024, claudeSupport: "text" }],
  ["application/json", { maxSize: 1 * 1024 * 1024, claudeSupport: "text" }],
  ["application/xml", { maxSize: 1 * 1024 * 1024, claudeSupport: "text" }],
  ["text/xml", { maxSize: 1 * 1024 * 1024, claudeSupport: "text" }],
  // Code files
  ["text/javascript", { maxSize: 512 * 1024, claudeSupport: "text" }],
  ["application/javascript", { maxSize: 512 * 1024, claudeSupport: "text" }],
  ["text/typescript", { maxSize: 512 * 1024, claudeSupport: "text" }],
  ["text/x-python", { maxSize: 512 * 1024, claudeSupport: "text" }],
  ["application/x-python", { maxSize: 512 * 1024, claudeSupport: "text" }],
]);

// Extension-based fallback for when MIME types are unreliable
const EXT_SUPPORT_MAP = new Map<string, ClaudeFileSupport>([
  ["pdf", "native"],
  ["txt", "text"], ["md", "text"], ["markdown", "text"],
  ["csv", "text"], ["tsv", "text"],
  ["json", "text"], ["xml", "text"], ["yaml", "text"], ["yml", "text"], ["toml", "text"],
  ["html", "text"], ["htm", "text"], ["css", "text"],
  ["js", "text"], ["jsx", "text"], ["ts", "text"], ["tsx", "text"], ["mjs", "text"],
  ["py", "text"], ["rb", "text"], ["rs", "text"], ["go", "text"], ["java", "text"],
  ["c", "text"], ["cpp", "text"], ["h", "text"], ["hpp", "text"],
  ["sh", "text"], ["bash", "text"], ["zsh", "text"],
  ["sql", "text"], ["graphql", "text"], ["gql", "text"],
  ["env", "text"], ["conf", "text"], ["ini", "text"], ["cfg", "text"],
  ["log", "text"], ["diff", "text"], ["patch", "text"],
  ["svelte", "text"], ["vue", "text"], ["astro", "text"],
  ["swift", "text"], ["kt", "text"], ["scala", "text"],
  ["r", "text"], ["R", "text"], ["lua", "text"], ["zig", "text"],
]);

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // absolute max: 10MB

export function getFileConfig(mediaType: string, filename?: string): FileTypeConfig {
  // First: check MIME type
  const byMime = FILE_TYPE_MAP.get(mediaType);
  if (byMime) return byMime;

  // Second: any text/* type
  if (mediaType.startsWith("text/")) {
    return { maxSize: 1 * 1024 * 1024, claudeSupport: "text" };
  }

  // Third: check file extension
  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext) {
      const support = EXT_SUPPORT_MAP.get(ext);
      if (support) {
        return {
          maxSize: support === "native" ? 10 * 1024 * 1024 : 1 * 1024 * 1024,
          claudeSupport: support,
        };
      }
    }
  }

  // Fallback: store but don't send to Claude
  return { maxSize: MAX_FILE_SIZE, claudeSupport: "none" };
}

export function extFromFilename(filename: string): string {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "bin";
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function slugify(title: string): string {
  return title.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 100);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// Route matching helper
export function matchRoute(
  method: string,
  path: string,
  routeMethod: string,
  pattern: string
): Record<string, string> | null {
  if (method !== routeMethod) return null;
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
