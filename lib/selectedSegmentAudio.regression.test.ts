import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractSegmentTimes, probeMedia, resolveFfmpegPath, resolveFfprobePath } from "./ffmpeg";
import { extractEditorSegment, repairSourceAvSegment } from "./sourceAvClock";
import { containAudioInputIdentity } from "./containAudioRepair";
import { hasProvenSelectedAudioLoss, recoverSelectedSegmentAudio } from "./selectedSegmentAudio";
import { exportCompositionToFile } from "./exportComposition";
import { createEmptyProject } from "./editor/project";
import type { Asset, MediaClip } from "./editor/types";

const sources = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/assetResolve", () => ({ resolveAssetInputPath: async (asset: Asset) => sources.get(asset.id) ?? null }));
const real = process.env.RUN_FFMPEG_TESTS === "1";
let dir: string, normal: string, positive: string, gap: string, silent: string, short: string, noaudio: string, stereo: string;
let probe4 = false;
const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024 });
beforeAll(async () => {
  if (!real) return;
  probe4 = /^ffprobe version 4\./.test(execFileSync(resolveFfprobePath(), ["-version"], { encoding: "utf8" }));
  dir = await mkdtemp(path.join(tmpdir(), "selected-audio-loss-"));
  normal = path.join(dir, "normal.mp4"); positive = path.join(dir, "positive.mp4");
  gap = path.join(dir, "gap.mp4"); silent = path.join(dir, "silent.mp4"); short = path.join(dir, "short.mp4"); noaudio = path.join(dir, "noaudio.mp4");
  ff(["-f", "lavfi", "-i", "color=blue:s=64x64:r=30:d=300", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=300",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-bf", "0", "-c:a", "aac", normal]);
  ff(["-copyts", "-i", normal, "-itsoffset", "2", "-i", normal, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-avoid_negative_ts", "disabled", positive]);
  ff(["-copyts", "-i", positive, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-bsf:a",
    "setts=pts=PTS+gte(N\\,10)*48000:dts=DTS+gte(N\\,10)*48000", gap]);
  for (const [output, audio] of [[silent, "anullsrc=r=48000:cl=mono:d=300"], [short, "sine=frequency=440:sample_rate=48000:duration=0.2"]]) {
    ff(["-i", normal, "-itsoffset", "2", "-f", "lavfi", "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", output]);
  }
  ff(["-i", normal, "-an", "-c:v", "copy", noaudio]);
  stereo = path.join(dir, "stereo.mp4");
  ff(["-i", normal, "-itsoffset", "2", "-f", "lavfi", "-i", "aevalsrc=0.08*sin(2*PI*440*t)|0.05*sin(2*PI*660*t):s=48000:d=300",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", stereo]);
  // Independent full-decode oracle, on disk rather than a 115MB PCM Buffer.
  // This is a fixed 300s test fixture, never a production full-source decode.
  for (const [name, input] of [["mono", positive], ["stereo", stereo]]) {
    const pcm = path.join(dir, name + "-full.pcm");
    ff(["-xerror", "-i", input, "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-f", "f32le", pcm]);
    expect((await stat(pcm)).size).toBeGreaterThanOrEqual(300 * 48000 * 8);
    expect((await stat(pcm)).size).toBeLessThan(301 * 48000 * 8);
  }
}, 60000);
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

async function oldOutput(input: string, name: string) {
  const output = path.join(dir, name + ".mp4"), inputIdentity = await containAudioInputIdentity(input);
  await extractSegmentTimes({ inputPath: input, outputPath: output, startSec: .1, endSec: .7 });
  return { input, output, start: .1, end: .7, inputIdentity };
}
it.skipIf(!real)("300-second source reproduces video-only success beyond the full-packet budget, then proves loss without rewriting bytes", async () => {
  const p = await oldOutput(positive, "long-old"), inputBefore = await readFile(positive), outputBefore = await readFile(p.output);
  expect((await probeMedia(p.output)).streams?.map(s => s.codec_type)).toEqual(["video"]);
  expect(await repairSourceAvSegment(p)).toBe(false);
  expect(await hasProvenSelectedAudioLoss(p)).toBe(true);
  expect(await readFile(p.output)).toEqual(outputBefore); expect(await readFile(positive)).toEqual(inputBefore);
  // The shared composition extraction entry point is deliberately unchanged.
  const shared = path.join(dir, "shared.mp4");
  await extractEditorSegment({ inputPath: positive, outputPath: shared, startSec: .1, endSec: .7 });
  expect((await probeMedia(shared)).streams?.map(s => s.codec_type)).toEqual(["video"]);
}, 30000);
it.skipIf(!real)("silent AAC is a real source track, not missing audio", async () => {
  const p = await oldOutput(silent, "silent-old");
  expect((await probeMedia(p.output)).streams?.some(s => s.codec_type === "audio")).toBe(false);
  expect(await hasProvenSelectedAudioLoss(p)).toBe(true);
});
it.skipIf(!real).each(["gap", "short", "noaudio"])("preserves unresolved source %s and exact output bytes", async kind => {
  const input = kind === "gap" ? gap : kind === "short" ? short : noaudio;
  const p = await oldOutput(input, kind + "-old"), before = await readFile(p.output);
  expect(await hasProvenSelectedAudioLoss(p)).toBe(false); expect(await readFile(p.output)).toEqual(before);
});
it.skipIf(!real)("preserves normal long output and a healthy output even with positive input metadata", async () => {
  const p = await oldOutput(normal, "healthy"), before = await readFile(p.output);
  expect((await probeMedia(p.output)).streams?.map(s => s.codec_type)).toEqual(["video", "audio"]);
  expect(await hasProvenSelectedAudioLoss(p)).toBe(false);
  expect(await hasProvenSelectedAudioLoss({ ...p, input: positive, inputIdentity: await containAudioInputIdentity(positive) })).toBe(false);
  expect(await readFile(p.output)).toEqual(before);
});
it.skipIf(!real)("normal gain-zero composition still succeeds without invoking selected-only rejection", async () => {
  const project = createEmptyProject(); project.compositionWidth = 320; project.compositionHeight = 320; project.compositionDurationSec = .6;
  const asset: Asset = { id: "normal", kind: "video", ext: "mp4", displayName: "normal", streamUrl: "/x", sourceDurationSec: 300, width: 64, height: 64 };
  sources.set(asset.id, normal); project.assets = [asset];
  const clip: MediaClip = { id: "clip", trackId: project.tracks[0].id, timelineStartSec: 0, durationSec: .6,
    audioGain: 0, transform: { x: .5, y: .5, scale: 1 }, parts: [{ assetId: asset.id, sourceInSec: .1, sourceOutSec: .7 }] };
  project.clips = [clip]; const saved = JSON.stringify(project), jobDir = path.join(dir, "composition"); await mkdir(jobDir);
  const outputPath = path.join(jobDir, "output.mp4"); await exportCompositionToFile({ project, jobDir, outputPath });
  expect((await probeMedia(outputPath)).streams?.some(s => s.codec_type === "video")).toBe(true);
  expect(JSON.stringify(project)).toBe(saved);
}, 30000);

const fixedFirst = new Map([[0, 0], [.1, 4800], [1 / 30, 1600], [.499999, 24000], [.5, 24000], [.500001, 24000]]);
function videoProof(file: string) {
  const raw = JSON.parse(execFileSync(resolveFfprobePath(), ["-v", "error", "-select_streams", "v:0", "-show_packets",
    "-show_entries", "packet=pts,dts,duration,size,data_hash", "-show_data_hash", "sha256", "-of", "json", file], { encoding: "utf8", maxBuffer: 1024 * 1024 }));
  return raw.packets;
}
async function recoveredOracle(input: string, name: string, start: number, count: number) {
  const first = fixedFirst.get(start); if (first === undefined) throw Error("Missing fixed sample oracle");
  const output = path.join(dir, `recovered-${name}-${start}-${count}.mp4`), inputIdentity = await containAudioInputIdentity(input);
  await extractSegmentTimes({ inputPath: input, outputPath: output, startSec: start, endSec: start + count / 48000 });
  const beforeVideo = videoProof(output), sourceBytes = await readFile(input);
  expect((await probeMedia(output)).streams?.map(s => s.codec_type)).toEqual(["video"]);
  const before = await readFile(output);
  const outcome = await recoverSelectedSegmentAudio({ input, output, start, end: start + count / 48000, inputIdentity });
  if (probe4 && name === "stereo" && count <= 1603) {
    // Probe4 interprets the original movie/edit timescale differently. Preserve
    // the strict gates rather than calling these one-frame cases recovered.
    if (count <= 1601) {
      expect(String(beforeVideo[0].duration)).toBe("522"); expect(outcome).toBe("missing");
    } else {
      expect(Number((await probeMedia(output)).streams![0].duration)).toBeGreaterThan(count / 48000 + 1 / 30);
      expect(outcome).toBe("unchanged");
    }
    expect((await readFile(output)).equals(before)).toBe(true); expect(videoProof(output)).toEqual(beforeVideo);
    expect((await readFile(input)).equals(sourceBytes)).toBe(true);
    return;
  }
  expect(outcome).toBe("repaired");
  expect(videoProof(output)).toEqual(beforeVideo); expect((await readFile(input)).equals(sourceBytes)).toBe(true);
  const raw = path.join(dir, `oracle-${name}-${start}-${count}.pcm`), oracle = raw + ".m4a", selected = Buffer.alloc(count * 8);
  const full = await open(path.join(dir, name + "-full.pcm"), "r");
  try { expect((await full.read(selected, 0, selected.length, first * 8)).bytesRead).toBe(selected.length); } finally { await full.close(); }
  await writeFile(raw, selected);
  // No production seek formatter, atrim, -ss or -t in this reference encoder.
  ff(["-f", "f32le", "-ac", "2", "-ar", "48000", "-i", raw, "-c:a", "aac", "-movie_timescale", "48000", oracle]);
  const decode = (file: string) => ff(["-xerror", "-i", file, "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1"]);
  expect(decode(output).equals(decode(oracle))).toBe(true);
  const audio = (await probeMedia(output)).streams!.find(s => s.codec_type === "audio")!;
  expect(audio.start_time).toBe("0.000000"); expect(String(audio.duration_ts)).toBe(String(count));
}
it.skipIf(!real).each([...fixedFirst.keys()])("recovers the bounded mono window at source %s against independent fixed PCM/AAC", async start => {
  await recoveredOracle(positive, "mono", start, 28800);
}, 30000);
it.skipIf(!real).each([1600, 1601, 1602, 1603, 47999, 48000])("stereo %s samples recover or preserve the explicit probe4 rounding boundary", async count => {
  await recoveredOracle(stereo, "stereo", count === 1600 ? 0 : .1, count);
}, 30000);
it.skipIf(!real)("healthy, gap, short, noaudio and oversized windows retain the old result and exact bytes", async () => {
  for (const input of [normal, gap, short, noaudio]) {
    const p = await oldOutput(input, "recovery-control-" + path.basename(input)), before = await readFile(p.output);
    expect(await recoverSelectedSegmentAudio(p)).toBe("unchanged"); expect(await readFile(p.output)).toEqual(before);
  }
  const p = await oldOutput(positive, "too-long"), output = path.join(dir, "too-long-window.mp4");
  await extractSegmentTimes({ inputPath: positive, outputPath: output, startSec: .1, endSec: 1.2 }); const before = await readFile(output);
  expect(await recoverSelectedSegmentAudio({ ...p, output, end: 1.2 })).toBe("missing"); expect(await readFile(output)).toEqual(before);
}, 30000);
