// Drive the real MCP wire (in-memory transport) against a mocked ElevenLabs
// client: tool registration, request shapes, dialogue chunking and, with
// ffmpeg, joining and episode assembly — without network or credentials.

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createElevenLabsServer, type ServerOptions } from "../src/server.js";
import type { ElevenLabsClient } from "../src/elevenlabs.js";

let tone: Uint8Array;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "el-tone-"));
  const f = join(dir, "tone.mp3");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", f]);
  tone = readFileSync(f);
});

function fake() {
  const calls: Array<{ path: string; params?: Record<string, string | undefined>; body: any }> = [];
  let n = 0;
  const client: ElevenLabsClient = {
    async json(method, path, params, body) {
      calls.push({ path, params, body });
      if (path === "/v1/user/subscription") return { tier: "creator", character_count: 1000, character_limit: 100000, next_character_count_reset_unix: 1_800_000_000 };
      if (path === "/v2/voices") return { voices: [{ voice_id: "v1", name: "Anna", category: "premade" }] };
      if (path === "/v1/shared-voices") return { total_count: 1, voices: [{ voice_id: "s1", public_owner_id: "o1", name: "Erik", language: "sv" }] };
      if (path.startsWith("/v1/voices/add/")) return { voice_id: "added1" };
      return {};
    },
    async audio(path, params, body) {
      calls.push({ path, params, body });
      return { data: tone, mimeType: "audio/mpeg", requestId: `req${++n}` };
    },
  };
  return { client, calls };
}

async function connect(client: ElevenLabsClient, opts: ServerOptions = {}) {
  const server = createElevenLabsServer(client, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return mcp;
}

const text = (r: any) => JSON.parse(r.content.find((c: any) => c.type === "text").text);

describe("server", () => {
  it("registers episode tools only with an output directory", async () => {
    const remote = await connect(fake().client);
    const names = (await remote.listTools()).tools.map(t => t.name);
    expect(names).toContain("text_to_dialogue");
    expect(names).not.toContain("assemble_episode");
    const local = await connect(fake().client, { outputDir: mkdtempSync(join(tmpdir(), "el-")) });
    expect((await local.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(["assemble_episode", "list_outputs"]));
  });

  it("reports credits left", async () => {
    const mcp = await connect(fake().client);
    expect(text(await mcp.callTool({ name: "check_subscription", arguments: {} }))).toMatchObject({ credits_left: 99000 });
  });

  it("returns audio inline in server mode", async () => {
    const { client, calls } = fake();
    const mcp = await connect(client);
    const r: any = await mcp.callTool({ name: "text_to_speech", arguments: { text: "Hej", voice_id: "v1", language_code: "sv" } });
    expect(r.content[0]).toMatchObject({ type: "audio", mimeType: "audio/mpeg" });
    expect(calls[0]).toMatchObject({ path: "/v1/text-to-speech/v1", params: { output_format: "mp3_44100_128" }, body: { text: "Hej", model_id: "eleven_multilingual_v2", language_code: "sv" } });
  });

  it("chunks a long script, chains request ids and joins the parts", async () => {
    const { client, calls } = fake();
    const dir = mkdtempSync(join(tmpdir(), "el-"));
    const mcp = await connect(client, { outputDir: dir });
    const lines = Array.from({ length: 5 }, (_, i) => ({ voice_id: i % 2 ? "a" : "b", text: "word ".repeat(180) }));
    const r = text(await mcp.callTool({ name: "text_to_dialogue", arguments: { lines, filename: "ep1" } }));
    expect(r).toMatchObject({ file: "ep1.mp3", requests: 3 });
    expect(r.seconds).toBeGreaterThan(2.5);
    expect(calls[2].body.previous_request_ids).toEqual(["req1", "req2"]);
    expect(readdirSync(dir)).toEqual(["ep1.mp3"]);
  });

  it("assembles an episode from files in the output directory", async () => {
    const { client } = fake();
    const dir = mkdtempSync(join(tmpdir(), "el-"));
    const mcp = await connect(client, { outputDir: dir });
    await mcp.callTool({ name: "compose_music", arguments: { prompt: "intro", filename: "intro" } });
    await mcp.callTool({ name: "sound_effect", arguments: { text: "whoosh", filename: "sfx" } });
    const r = text(await mcp.callTool({
      name: "assemble_episode",
      arguments: { segments: [{ file: "intro.mp3", fade_out: 0.5, gap_after: 0.5 }, { file: "sfx.mp3", gain_db: -6 }], filename: "episode" },
    }));
    expect(r.file).toBe("episode.mp3");
    expect(r.seconds).toBeGreaterThan(2.3);
    expect(existsSync(join(dir, "episode.mp3"))).toBe(true);
  });

  it("refuses files outside the output directory", async () => {
    const mcp = await connect(fake().client, { outputDir: mkdtempSync(join(tmpdir(), "el-")) });
    const r: any = await mcp.callTool({ name: "assemble_episode", arguments: { segments: [{ file: "../../etc/hosts" }], filename: "x" } });
    expect(r.isError).toBe(true);
  });
});
