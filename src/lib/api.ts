// Backend bridge to the Deno process (main.ts).
//
// Two channels, both same-origin (Deno.serve hosts the SPA):
//   - HTTP  /api/*  — request/response (config, db queries, spawn/write/resize)
//   - WS    /ws     — push stream. In Phase 1 this carries PTY output frames
//                     from the Rust sidecar; for now it's a plain echo.

export interface PingResult {
  ok: boolean;
  runtime: string;
  ts: number;
}

export async function ping(): Promise<PingResult> {
  const res = await fetch("/api/ping");
  if (!res.ok) throw new Error(`ping failed: ${res.status}`);
  return res.json();
}

export function openEcho(onMessage: (msg: string) => void): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener("message", (e) => onMessage(String(e.data)));
  return ws;
}
