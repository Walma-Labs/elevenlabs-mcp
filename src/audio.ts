// Local audio work with ffmpeg/ffprobe: joining dialogue chunks, probing
// durations and assembling episodes. Only used by the local stdio bin, where
// files live in the output directory.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assemblyFilter, type Segment } from "./logic.js";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export async function duration(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`Could not read the duration of ${file}`);
  return d;
}

/** Join files end to end (re-encoded, so mixed formats and bitrates work). */
export async function concat(files: string[], out: string): Promise<void> {
  if (files.length === 1) {
    await run(FFMPEG, ["-y", "-v", "error", "-i", files[0], "-c", "copy", out]);
    return;
  }
  const filter = files.map((_, i) => `[${i}:a]`).join("") + `concat=n=${files.length}:v=0:a=1[out]`;
  await run(FFMPEG, ["-y", "-v", "error", ...files.flatMap(f => ["-i", f]), "-filter_complex", filter, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k", out]);
}

export async function assemble(segments: Segment[], out: string, normalize: boolean): Promise<number> {
  const withDur = await Promise.all(segments.map(async s => ({ ...s, duration: await duration(s.file) })));
  await run(FFMPEG, [
    "-y", "-v", "error",
    ...segments.flatMap(s => ["-i", s.file]),
    "-filter_complex", assemblyFilter(withDur, normalize),
    "-map", "[out]", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", out,
  ], { maxBuffer: 16 * 1024 * 1024 });
  return duration(out);
}
