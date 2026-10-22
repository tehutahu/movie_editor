import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractSegmentTimes, probeMedia, resolveFfmpegPath } from "./ffmpeg";
import { extractEditorSegment, repairSourceAvSegment } from "./sourceAvClock";
import { containAudioInputIdentity } from "./containAudioRepair";
import { hasProvenSelectedAudioLoss } from "./selectedSegmentAudio";
import { exportCompositionToFile } from "./exportComposition";
import { createEmptyProject } from "./editor/project";
import type { Asset, MediaClip } from "./editor/types";

const sources = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/assetResolve", () => ({ resolveAssetInputPath: async (asset: Asset) => sources.get(asset.id) ?? null }));
const real = process.env.RUN_FFMPEG_TESTS === "1";
let dir: string, normal: string, positive: string, gap: string, silent: string, short: string, noaudio: string;
const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024 });
beforeAll(async () => {
  if (!real) return;
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
