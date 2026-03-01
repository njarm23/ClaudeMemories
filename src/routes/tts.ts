import type { Env } from "../types";
import { error } from "../utils";

/**
 * TTS route — proxies text to OpenAI's TTS API and streams audio back.
 * POST /api/tts  { text, voice? }  →  audio/mpeg binary stream
 */
export async function handleTTSRoutes(
  method: string,
  path: string,
  _url: URL,
  request: Request,
  env: Env
): Promise<Response | null> {
  if (method !== "POST" || path !== "/api/tts") return null;

  if (!env.OPENAI_API_KEY) {
    return error("OpenAI API key not configured", 500);
  }

  const body = await request.json() as { text?: string; voice?: string };
  const text = body.text?.trim();
  if (!text) {
    return error("text is required", 400);
  }

  // OpenAI TTS has a 4096 character limit per request
  const truncated = text.length > 4096 ? text.slice(0, 4096) : text;

  const voice = body.voice || "nova";
  const allowedVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
  if (!allowedVoices.includes(voice)) {
    return error(`Invalid voice. Choose from: ${allowedVoices.join(", ")}`, 400);
  }

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: truncated,
        voice,
        response_format: "mp3",
      }),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text();
      console.error("OpenAI TTS error:", openaiRes.status, errBody);
      return error(`TTS generation failed: ${openaiRes.status}`, 502);
    }

    // Stream the audio bytes straight through to the client
    return new Response(openaiRes.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e: any) {
    console.error("TTS error:", e.message);
    return error(`TTS error: ${e.message}`, 500);
  }
}
