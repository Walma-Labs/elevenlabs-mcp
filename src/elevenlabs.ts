// ElevenLabs API client: the thin request layer the tools need. Plain `fetch`
// behind an injectable interface, so tests and the Walma MCP chassis run
// without network or credentials.
//
// Credentials:
//   ELEVENLABS_API_KEY        — the key itself (server mode: Key Vault
//                               `mcp-elevenlabs-api-key`).
//   ELEVENLABS_CREDENTIALS    — local mode: an env-style file holding
//                               ELEVENLABS_API_KEY=... (default
//                               ~/.config/elevenlabs-mcp/credentials.env, chmod 600).
//   ELEVENLABS_BASE_URL       — optional, e.g. https://api.eu.residency.elevenlabs.io
//                               for EU data residency.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export const DEFAULT_BASE_URL = "https://api.elevenlabs.io";

export interface AudioResponse {
  data: Uint8Array;
  mimeType: string;
  /** ElevenLabs `request-id`, used to stitch dialogue chunks together. */
  requestId?: string;
}

/** What the tools use — injectable for tests. */
export interface ElevenLabsClient {
  json(method: "GET" | "POST", path: string, params?: Record<string, string | undefined>, body?: unknown): Promise<any>;
  audio(path: string, params: Record<string, string | undefined>, body: unknown): Promise<AudioResponse>;
}

export function credentialsPath(): string {
  const p = process.env.ELEVENLABS_CREDENTIALS || "~/.config/elevenlabs-mcp/credentials.env";
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

export function apiKey(): string {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  const file = credentialsPath();
  if (existsSync(file)) {
    const m = readFileSync(file, "utf8").match(/^\s*ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/m);
    if (m) return m[1];
  }
  throw new Error(`No ElevenLabs API key: set ELEVENLABS_API_KEY or put ELEVENLABS_API_KEY=... in ${file}`);
}

function query(params?: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function fail(resp: Response): Promise<never> {
  let detail = (await resp.text()).slice(0, 500);
  try {
    const d = JSON.parse(detail).detail;
    detail = typeof d === "string" ? d : d?.message ?? JSON.stringify(d);
  } catch { /* not JSON */ }
  throw new Error(`ElevenLabs API ${resp.status}: ${detail}`);
}

export function createElevenLabsClient(key?: string, baseUrl = process.env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL): ElevenLabsClient {
  // Resolved lazily so the server starts (and lists its tools) without a key.
  const headers = () => ({ "xi-api-key": key ?? apiKey() });
  return {
    async json(method, path, params, body) {
      const resp = await fetch(`${baseUrl}${path}${query(params)}`, {
        method,
        headers: { ...headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!resp.ok) await fail(resp);
      return resp.json();
    },
    async audio(path, params, body) {
      const resp = await fetch(`${baseUrl}${path}${query(params)}`, {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) await fail(resp);
      return {
        data: new Uint8Array(await resp.arrayBuffer()),
        mimeType: resp.headers.get("content-type")?.split(";")[0] || "audio/mpeg",
        requestId: resp.headers.get("request-id") ?? undefined,
      };
    },
  };
}
