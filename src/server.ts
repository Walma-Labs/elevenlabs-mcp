// The MCP server factory. One implementation, two consumers: the stdio bin
// (local podcast production with Claude Code / Desktop) and the Walma MCP
// chassis, which imports createElevenLabsServer and mounts it behind the gateway.
//
// Locally (`outputDir` set) generated audio is written to that directory and
// the episode tools (assemble_episode, list_outputs) are registered — they
// need ffmpeg and the files. In server mode audio comes back inline as MCP
// audio content and nothing touches the disk.

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createElevenLabsClient, type AudioResponse, type ElevenLabsClient } from "./elevenlabs.js";
import { chunkDialogue, extensionFor, safeFilename, stamp } from "./logic.js";
import * as audio from "./audio.js";

export const VERSION = "0.1.0";

export const INSTRUCTIONS =
  "ElevenLabs audio for podcast production. Find voices with list_voices (your own) or " +
  "search_voice_library (shared, add one with add_library_voice before use). Write episodes " +
  "as text_to_dialogue lines (eleven_v3 understands audio tags like [laughs], [whispers], " +
  "[excited]); use compose_music for intro/outro beds and sound_effect for stingers. Every " +
  "generation spends credits — check_subscription shows what is left. Generate short " +
  "samples before a full episode.";

const LOCAL_INSTRUCTIONS =
  " Audio is saved to the local output directory; assemble_episode joins files into a " +
  "finished episode (fades, gaps, -16 LUFS loudness).";

export interface ServerOptions {
  /** Save audio here and enable the episode tools. Only for the local stdio
   * bin: a shared container has no user disk to write to. */
  outputDir?: string;
}

const OUTPUT_FORMATS = ["mp3_44100_128", "mp3_44100_192", "opus_48000_128", "wav_44100", "pcm_44100"] as const;

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createElevenLabsServer(client: ElevenLabsClient = createElevenLabsClient(), opts: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "elevenlabs", version: VERSION },
    { instructions: INSTRUCTIONS + (opts.outputDir ? LOCAL_INSTRUCTIONS : "") },
  );
  const outDir = opts.outputDir ? resolve(opts.outputDir) : undefined;

  /** A path inside the output directory — never outside it. */
  function inOutput(name: string): string {
    const p = resolve(outDir!, name);
    if (!p.startsWith(outDir! + sep)) throw new Error(`${name} is outside the output directory`);
    return p;
  }

  async function deliver(res: AudioResponse, filename: string, meta: Record<string, unknown>) {
    if (!outDir) {
      return {
        content: [
          { type: "audio" as const, data: Buffer.from(res.data).toString("base64"), mimeType: res.mimeType },
          { type: "text" as const, text: JSON.stringify(meta, null, 2) },
        ],
      };
    }
    await mkdir(outDir, { recursive: true });
    const path = inOutput(filename);
    await writeFile(path, res.data);
    return jsonResult({ file: filename, path, bytes: res.data.length, ...meta });
  }

  const format = z.enum(OUTPUT_FORMATS).default("mp3_44100_128")
    .describe("Audio format. 192 kbps MP3 needs Creator tier; WAV/PCM 44.1 kHz needs Pro.");
  const filename = z.string().optional().describe("File name to save as (no folders). Defaults to a timestamped name.");

  // --- account & catalogue ---------------------------------------------------

  server.registerTool("check_subscription", {
    description: "Plan, credits used and left, and when the quota resets.",
    inputSchema: {},
  }, async () => {
    const s = await client.json("GET", "/v1/user/subscription");
    return jsonResult({
      tier: s.tier,
      status: s.status,
      credits_used: s.character_count,
      credit_limit: s.character_limit,
      credits_left: s.character_limit - s.character_count,
      resets_at: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null,
      voice_slots: `${s.voice_slots_used ?? "?"}/${s.voice_limit ?? "?"}`,
      can_use_instant_voice_cloning: s.can_use_instant_voice_cloning,
    });
  });

  server.registerTool("list_models", {
    description: "Speech models with their languages. eleven_v3 is the most expressive (dialogue, audio tags); eleven_multilingual_v2 is the most stable for long narration; flash/turbo are fast and cheap.",
    inputSchema: {},
  }, async () => {
    const models = await client.json("GET", "/v1/models");
    return jsonResult(models.map((m: any) => ({
      model_id: m.model_id,
      name: m.name,
      tts: m.can_do_text_to_speech,
      max_characters: m.maximal_text_length_per_request ?? m.max_characters_request_subscribed_user,
      languages: (m.languages ?? []).map((l: any) => l.language_id),
    })));
  });

  server.registerTool("list_voices", {
    description: "Voices in your own library (premade, cloned, designed and added from the shared library), with their voice_id.",
    inputSchema: {
      search: z.string().optional().describe("Name, description or label to search for"),
      page_size: z.number().int().min(1).max(100).default(30),
    },
  }, async ({ search, page_size }) => {
    const r = await client.json("GET", "/v2/voices", { search, page_size: String(page_size) });
    return jsonResult(r.voices.map((v: any) => ({
      voice_id: v.voice_id, name: v.name, category: v.category, labels: v.labels, description: v.description, preview_url: v.preview_url,
    })));
  });

  server.registerTool("search_voice_library", {
    description: "Search ElevenLabs' shared voice library (thousands of community voices, by language/accent/gender/use case). Add a voice with add_library_voice before using it.",
    inputSchema: {
      search: z.string().optional().describe("Free text, e.g. 'warm narrator' or 'podcast host'"),
      language: z.string().optional().describe("ISO 639-1, e.g. 'sv' or 'en'"),
      accent: z.string().optional().describe("e.g. 'american', 'british', 'swedish'"),
      gender: z.enum(["male", "female", "neutral"]).optional(),
      age: z.enum(["young", "middle_aged", "old"]).optional(),
      use_case: z.string().optional().describe("e.g. 'narrative_story', 'conversational', 'informative_educational'"),
      sort: z.enum(["trending", "usage_character_count_1y", "cloned_by_count", "created_date"]).default("trending"),
      page_size: z.number().int().min(1).max(100).default(20),
    },
  }, async ({ search, language, accent, gender, age, use_case, sort, page_size }) => {
    const r = await client.json("GET", "/v1/shared-voices", {
      search, language, accent, gender, age, use_cases: use_case, sort, page_size: String(page_size),
    });
    return jsonResult({
      total: r.total_count,
      voices: r.voices.map((v: any) => ({
        voice_id: v.voice_id, public_owner_id: v.public_owner_id, name: v.name, language: v.language, accent: v.accent,
        gender: v.gender, age: v.age, use_case: v.use_case, descriptive: v.descriptive, description: v.description,
        preview_url: v.preview_url, already_added: v.is_added_by_user ?? false,
      })),
    });
  });

  server.registerTool("add_library_voice", {
    description: "Add a shared-library voice to your own voices so it can be used for speech. Uses a voice slot.",
    inputSchema: {
      public_owner_id: z.string().describe("public_owner_id from search_voice_library"),
      voice_id: z.string(),
      name: z.string().describe("Name to give it in your library, e.g. 'Host – Anna'"),
    },
  }, async ({ public_owner_id, voice_id, name }) => {
    const r = await client.json("POST", `/v1/voices/add/${encodeURIComponent(public_owner_id)}/${encodeURIComponent(voice_id)}`, undefined, { new_name: name });
    return jsonResult({ voice_id: r.voice_id, name });
  });

  // --- generation ---------------------------------------------------------------

  server.registerTool("text_to_speech", {
    description: "One voice reading a text — narration, a cold open, an ad read. For several speakers use text_to_dialogue.",
    inputSchema: {
      text: z.string().min(1),
      voice_id: z.string(),
      model_id: z.string().default("eleven_multilingual_v2").describe("eleven_multilingual_v2 (stable, long text), eleven_v3 (expressive, audio tags), eleven_flash_v2_5 (fast/cheap)"),
      language_code: z.string().optional().describe("ISO 639-1, e.g. 'sv' — forces the language where the model supports it"),
      stability: z.number().min(0).max(1).optional().describe("Lower = more expressive, higher = more consistent"),
      similarity_boost: z.number().min(0).max(1).optional(),
      style: z.number().min(0).max(1).optional(),
      speed: z.number().min(0.7).max(1.2).optional(),
      output_format: format,
      filename,
    },
  }, async ({ text, voice_id, model_id, language_code, stability, similarity_boost, style, speed, output_format, filename: name }) => {
    const voice_settings = Object.fromEntries(Object.entries({ stability, similarity_boost, style, speed }).filter(([, v]) => v !== undefined));
    const res = await client.audio(`/v1/text-to-speech/${encodeURIComponent(voice_id)}`, { output_format }, {
      text, model_id, language_code, ...(Object.keys(voice_settings).length ? { voice_settings } : {}),
    });
    return deliver(res, safeFilename(name ?? stamp("speech"), extensionFor(output_format)), { characters: text.length, model_id });
  });

  server.registerTool("text_to_dialogue", {
    description:
      "Multi-speaker conversation in one natural take (eleven_v3) — the core podcast tool. Pass the script as ordered lines, " +
      "each with a voice_id. Long scripts are split into ~2 000-character requests (whole lines kept together) and joined; " +
      "locally that needs ffmpeg. Audio tags in the text steer delivery: [laughs], [sighs], [whispers], [excited], [interrupting].",
    inputSchema: {
      lines: z.array(z.object({
        voice_id: z.string(),
        text: z.string().min(1),
      })).min(1),
      model_id: z.string().default("eleven_v3"),
      language_code: z.string().optional().describe("ISO 639-1, e.g. 'en' or 'sv'"),
      stability: z.number().min(0).max(1).optional().describe("0 = creative, 0.5 = natural, 1 = robust"),
      seed: z.number().int().min(0).optional(),
      output_format: format,
      filename,
    },
  }, async ({ lines, model_id, language_code, stability, seed, output_format, filename: name }) => {
    const chunks = chunkDialogue(lines);
    if (chunks.length > 1 && !outDir) {
      throw new Error(`This script needs ${chunks.length} requests; in server mode send at most ~2 000 characters per call.`);
    }
    if (chunks.length > 1 && output_format.startsWith("pcm")) {
      throw new Error("Raw PCM has no header to join on; use an mp3, opus or wav format for scripts over ~2 000 characters.");
    }
    const file = safeFilename(name ?? stamp("dialogue"), extensionFor(output_format));
    const body = (inputs: typeof lines, prev: string[]) => ({
      inputs, model_id, language_code, seed,
      ...(stability !== undefined ? { settings: { stability } } : {}),
      ...(prev.length ? { previous_request_ids: prev.slice(-3) } : {}),
    });
    const characters = lines.reduce((n, l) => n + l.text.length, 0);
    if (chunks.length === 1) {
      const res = await client.audio("/v1/text-to-dialogue", { output_format }, body(chunks[0], []));
      return deliver(res, file, { characters, requests: 1, model_id });
    }
    // Several requests: each part continues from the previous ones' request ids
    // so prosody carries over, then ffmpeg joins them.
    await mkdir(outDir!, { recursive: true });
    const parts: string[] = [];
    const prev: string[] = [];
    for (const [i, chunk] of chunks.entries()) {
      const res = await client.audio("/v1/text-to-dialogue", { output_format }, body(chunk, prev));
      if (res.requestId) prev.push(res.requestId);
      const part = inOutput(`.${file}.part${i}.${extensionFor(output_format)}`);
      await writeFile(part, res.data);
      parts.push(part);
    }
    const path = inOutput(file);
    await audio.concat(parts, path);
    await Promise.all(parts.map(p => rm(p, { force: true })));
    return jsonResult({ file, path, characters, requests: chunks.length, model_id, seconds: await audio.duration(path) });
  });

  server.registerTool("compose_music", {
    description: "Original music from a text prompt — intro/outro themes, beds under speech, transitions. Licensed for commercial use on paid plans.",
    inputSchema: {
      prompt: z.string().min(1).describe("Genre, mood, instruments, tempo, structure, e.g. 'upbeat lo-fi podcast intro, warm Rhodes, soft drums, 90 bpm, clean ending'"),
      seconds: z.number().min(3).max(600).optional().describe("Length; omitted = the model decides"),
      instrumental: z.boolean().default(true).describe("Guarantee no vocals (what you want under speech)"),
      model_id: z.enum(["music_v1", "music_v2", "music_v2_5"]).optional(),
      filename,
    },
  }, async ({ prompt, seconds, instrumental, model_id, filename: name }) => {
    const res = await client.audio("/v1/music", {}, {
      prompt, force_instrumental: instrumental, model_id,
      ...(seconds ? { music_length_ms: Math.round(seconds * 1000) } : {}),
    });
    return deliver(res, safeFilename(name ?? stamp("music"), "mp3"), { prompt, seconds: seconds ?? "auto" });
  });

  server.registerTool("sound_effect", {
    description: "A sound effect from a description — stingers, whooshes, ambience, applause.",
    inputSchema: {
      text: z.string().min(1).describe("e.g. 'short airy whoosh transition'"),
      seconds: z.number().min(0.5).max(30).optional(),
      prompt_influence: z.number().min(0).max(1).default(0.3).describe("Higher = follows the prompt more literally"),
      loop: z.boolean().default(false).describe("Seamless loop (for ambience beds)"),
      filename,
    },
  }, async ({ text, seconds, prompt_influence, loop, filename: name }) => {
    const res = await client.audio("/v1/sound-generation", { output_format: "mp3_44100_128" }, {
      text, prompt_influence, loop, ...(seconds ? { duration_seconds: seconds } : {}),
    });
    return deliver(res, safeFilename(name ?? stamp("sfx"), "mp3"), { text });
  });

  // --- episode tools (local only) -----------------------------------------------

  if (outDir) {
    server.registerTool("list_outputs", {
      description: "Audio files in the output directory, newest first, with duration.",
      inputSchema: {},
    }, async () => {
      await mkdir(outDir, { recursive: true });
      const names = (await readdir(outDir)).filter(n => !n.startsWith(".") && /\.(mp3|wav|opus|m4a)$/i.test(n));
      const files = await Promise.all(names.map(async n => {
        const p = join(outDir, n);
        const st = await stat(p);
        return { file: n, seconds: Number((await audio.duration(p).catch(() => NaN)).toFixed(1)), modified: st.mtime.toISOString() };
      }));
      return jsonResult({ dir: outDir, files: files.sort((a, b) => b.modified.localeCompare(a.modified)) });
    });

    server.registerTool("assemble_episode", {
      description:
        "Join audio files from the output directory into a finished episode, in order: e.g. intro music → dialogue → stinger → " +
        "dialogue → outro. Per segment: fades, a gap after, gain. The result is normalised to -16 LUFS (podcast standard), MP3 192 kbps.",
      inputSchema: {
        segments: z.array(z.object({
          file: z.string().describe("File name in the output directory"),
          fade_in: z.number().min(0).max(30).optional(),
          fade_out: z.number().min(0).max(30).optional(),
          gap_after: z.number().min(0).max(10).optional().describe("Seconds of silence after"),
          gain_db: z.number().min(-30).max(10).optional(),
        })).min(1),
        filename: z.string().describe("Episode file name, e.g. 'ep01-ai-agents'"),
        normalize: z.boolean().default(true),
      },
    }, async ({ segments, filename: name, normalize }) => {
      const file = safeFilename(name, "mp3");
      const path = inOutput(file);
      const seconds = await audio.assemble(segments.map(s => ({ ...s, file: inOutput(s.file) })), path, normalize);
      return jsonResult({ file, path, seconds: Number(seconds.toFixed(1)), minutes: Number((seconds / 60).toFixed(2)) });
    });
  }

  return server;
}
