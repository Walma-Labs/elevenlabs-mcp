import { describe, it, expect } from "vitest";
import { assemblyFilter, chunkDialogue, safeFilename, splitText } from "../src/logic.js";

describe("chunkDialogue", () => {
  it("keeps short scripts in one request", () => {
    const lines = [{ voice_id: "a", text: "Hi" }, { voice_id: "b", text: "Hello" }];
    expect(chunkDialogue(lines)).toEqual([lines]);
  });

  it("splits at line boundaries under the character limit", () => {
    const lines = Array.from({ length: 5 }, (_, i) => ({ voice_id: i % 2 ? "a" : "b", text: "x".repeat(900) }));
    const chunks = chunkDialogue(lines);
    expect(chunks.map(c => c.length)).toEqual([2, 2, 1]);
    for (const c of chunks) expect(c.reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(2000);
  });

  it("starts a new request past ten voices", () => {
    const lines = Array.from({ length: 11 }, (_, i) => ({ voice_id: `v${i}`, text: "hi" }));
    expect(chunkDialogue(lines).map(c => c.length)).toEqual([10, 1]);
  });

  it("splits a single over-long line at sentences", () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const parts = splitText(text, 500);
    expect(parts.every(p => p.length <= 500 && p.endsWith("."))).toBe(true);
    expect(parts.join(" ")).toBe(text);
  });
});

describe("safeFilename", () => {
  it("strips folders, odd characters and the old extension", () => {
    expect(safeFilename("../../etc/passwd", "mp3")).toBe("passwd.mp3");
    expect(safeFilename("Avsnitt 1: AI-agenter!.wav", "mp3")).toBe("Avsnitt-1-AI-agenter.mp3");
    expect(() => safeFilename("...", "mp3")).toThrow();
  });
});

describe("assemblyFilter", () => {
  it("builds fades, gaps, gain and loudness normalisation", () => {
    const f = assemblyFilter([
      { file: "a", duration: 10, fade_in: 1, fade_out: 2, gain_db: -6 },
      { file: "b", duration: 5, gap_after: 0.5 },
    ]);
    expect(f).toContain("[0:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=-6dB,afade=t=in:st=0:d=1,afade=t=out:st=8.000:d=2[s0]");
    expect(f).toContain("[1:a]aformat=sample_rates=44100:channel_layouts=stereo,apad=pad_dur=0.5[s1]");
    expect(f).toMatch(/\[s0\]\[s1\]concat=n=2:v=0:a=1,loudnorm=I=-16:TP=-1\.5:LRA=11\[out\]$/);
  });
});
