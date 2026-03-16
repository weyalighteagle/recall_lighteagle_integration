import { env } from "../config/env.js";
import type { IncomingMessage, ServerResponse } from "http";

export function handleVoiceAgentStatus(_req: IncomingMessage, res: ServerResponse): void {
  const enabled = Boolean(env.VOICE_AGENT_PAGE_URL && env.VOICE_AGENT_WSS_URL);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(
    JSON.stringify({
      enabled,
      // pageUrl is safe to expose — it's a public URL the bot opens
      // Do NOT expose VOICE_AGENT_WSS_URL — it's a backend-internal WSS URL
      pageUrl: env.VOICE_AGENT_PAGE_URL ?? null,
    })
  );
}
