import type { Env } from "./types";
import { json, error } from "./utils";

const TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

// URL-safe base64 encoding (RFC 4648 §5)
function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  // Pad with '=' to make length a multiple of 4
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return atob(padded);
}

// Simple JWT implementation for Cloudflare Workers
async function createToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = toBase64Url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const signature = toBase64Url(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}.${signature}`;
}

async function verifyToken(token: string, secret: string): Promise<boolean> {
  try {
    const [header, body, signature] = token.split(".");
    if (!header || !body || !signature) return false;

    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = Uint8Array.from(fromBase64Url(signature), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return false;

    // Check expiration
    const payload = JSON.parse(fromBase64Url(body));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return false; // Token expired
    }

    return true;
  } catch {
    return false;
  }
}

// Handle POST /api/auth/login
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { password?: string };
    if (!body.password || body.password !== env.AUTH_PASSWORD) {
      return error("Invalid password", 401);
    }
    const now = Math.floor(Date.now() / 1000);
    const token = await createToken(
      { sub: "user", iat: now, exp: now + TOKEN_MAX_AGE_SECONDS },
      env.JWT_SECRET
    );
    return json({ token });
  } catch {
    return error("Invalid request body");
  }
}

// Auth middleware — returns error Response if not authenticated, null if OK
export async function authenticate(request: Request, env: Env): Promise<Response | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return error("Unauthorized", 401);
  }
  const token = authHeader.slice(7);
  const valid = await verifyToken(token, env.JWT_SECRET);
  if (!valid) {
    return error("Invalid token", 401);
  }
  return null; // Authenticated
}
