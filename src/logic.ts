// Pure helpers: dialogue chunking, file naming and the ffmpeg filter graph for
// episode assembly. No I/O here, so it is all unit-testable.

/** text-to-dialogue accepts ~2 000 characters and 10 distinct voices per request. */
export const DIALOGUE_MAX_CHARS = 2000;
export const DIALOGUE_MAX_VOICES = 10;

export interface DialogueLine {
  voice_id: string;
  text: string;
}

/** Split one over-long line at sentence (then word) boundaries. */
export function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf("\n"));
    cut = cut > max / 3 ? cut + 1 : window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Group dialogue lines into requests that respect the per-request limits,
 * never splitting a line unless it alone is over the limit. */
export function chunkDialogue(lines: DialogueLine[], maxChars = DIALOGUE_MAX_CHARS, maxVoices = DIALOGUE_MAX_VOICES): DialogueLine[][] {
  const chunks: DialogueLine[][] = [];
  let cur: DialogueLine[] = [];
  let chars = 0;
  for (const line of lines) {
    for (const text of splitText(line.text, maxChars)) {
      const voices = new Set(cur.map(l => l.voice_id).concat(line.voice_id));
      if (cur.length && (chars + text.length > maxChars || voices.size > maxVoices)) {
        chunks.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push({ voice_id: line.voice_id, text });
      chars += text.length;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** A bare, safe file name: no directories, no dot-files, given extension. */
export function safeFilename(name: string, ext: string): string {
  const base = name.split(/[\\/]/).pop()!.replace(/\.[a-z0-9]{2,4}$/i, "");
  const clean = base.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 100);
  if (!clean) throw new Error(`Invalid file name: ${name}`);
  return `${clean}.${ext}`;
}

export function extensionFor(outputFormat: string): string {
  if (outputFormat.startsWith("mp3")) return "mp3";
  if (outputFormat.startsWith("opus")) return "opus";
  if (outputFormat.startsWith("wav")) return "wav";
  if (outputFormat.startsWith("pcm")) return "pcm";
  return "mp3";
}

export function stamp(prefix: string, now = new Date()): string {
  return `${prefix}-${now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}`;
}

export interface Segment {
  file: string;
  /** Seconds of fade at the start / end of this segment. */
  fade_in?: number;
  fade_out?: number;
  /** Seconds of silence after this segment. */
  gap_after?: number;
  /** Gain in dB for this segment (e.g. -6 for a quieter jingle). */
  gain_db?: number;
}

/** filter_complex for: per-segment format/gain/fades/gap → concat → loudness
 * normalisation to the podcast standard (-16 LUFS, -1.5 dBTP). */
export function assemblyFilter(segments: Array<Segment & { duration: number }>, normalize = true): string {
  const parts = segments.map((s, i) => {
    const f = ["aformat=sample_rates=44100:channel_layouts=stereo"];
    if (s.gain_db) f.push(`volume=${s.gain_db}dB`);
    if (s.fade_in) f.push(`afade=t=in:st=0:d=${s.fade_in}`);
    if (s.fade_out) f.push(`afade=t=out:st=${Math.max(0, s.duration - s.fade_out).toFixed(3)}:d=${s.fade_out}`);
    if (s.gap_after) f.push(`apad=pad_dur=${s.gap_after}`);
    return `[${i}:a]${f.join(",")}[s${i}]`;
  });
  const inputs = segments.map((_, i) => `[s${i}]`).join("");
  const tail = normalize ? ",loudnorm=I=-16:TP=-1.5:LRA=11" : "";
  return `${parts.join(";")};${inputs}concat=n=${segments.length}:v=0:a=1${tail}[out]`;
}
