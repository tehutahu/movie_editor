import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractSegmentTimes, probeMedia, resolveFfmpegPath, resolveFfprobePath } from "./ffmpeg";
import { extractEditorSegment, repairSourceAvSegment } from "./sourceAvClock";
import { containAudioInputIdentity } from "./containAudioRepair";
import { hasProvenSelectedAudioLoss, recoverSelectedSegmentAudio } from "./selectedSegmentAudio";
import { exportCompositionToFile } from "./exportComposition";
import { renderClipToFile } from "./renderClip";
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
  ff(["-f", "lavfi", "-i", "color=blue:s=64x64:r=30:d=300", "-f", "lavfi", "-i", "aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*(gte(t\\,0.5)*lt(t\\,0.52)+gte(t\\,250.5)*lt(t\\,250.52)):s=48000:d=300",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-bf", "0", "-c:a", "aac", normal]);
  ff(["-copyts", "-i", normal, "-itsoffset", "2", "-i", normal, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-avoid_negative_ts", "disabled", positive]);
  ff(["-copyts", "-i", positive, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-bsf:a",
    "setts=pts=PTS+gte(N\\,10)*48000:dts=DTS+gte(N\\,10)*48000", gap]);
  for (const [output, audio] of [[silent, "anullsrc=r=48000:cl=mono:d=300"], [short, "sine=frequency=440:sample_rate=48000:duration=0.2"]]) {
    ff(["-i", normal, "-itsoffset", "2", "-f", "lavfi", "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", output]);
  }
  ff(["-i", normal, "-an", "-c:v", "copy", noaudio]);
  stereo = path.join(dir, "stereo.mp4");
  ff(["-i", normal, "-itsoffset", "2", "-f", "lavfi", "-i", "aevalsrc=0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52)|0.02*sin(2*PI*660*t)+0.25*sin(2*PI*3000*t)*gte(t\\,0.8)*lt(t\\,0.82):s=48000:d=300",
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
  const actual = decode(output); expect(actual.equals(decode(oracle))).toBe(true);
  if (name === "mono" && start === .1 && count === 28800) {
    const rms = (a: number, b: number) => {
      let sum = 0; for (let n = Math.round(a * 48000); n < Math.round(b * 48000); n++) sum += actual.readInt16LE(n * 4) ** 2;
      return Math.sqrt(sum / Math.round((b - a) * 48000));
    };
    expect(rms(.426, .436)).toBeGreaterThan(4000); expect(rms(.2, .22)).toBeLessThan(1500);
  }
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


function rmsAt(pcm: Buffer, first: number, end: number) {
  // The caller must prove this fixed window exists; absent audio is not silence.
  expect(pcm.length).toBeGreaterThanOrEqual(end * 4);
  let sum = 0;
  for (let n = first; n < end; n++) sum += pcm.readInt16LE(n * 4) ** 2;
  return Math.sqrt(sum / (end - first));
}
function decodedStereo(file: string) {
  return ff(["-xerror", "-i", file, "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1"]);
}
function expectBlueFrames(file: string) {
  const rgb = ff(["-xerror", "-i", file, "-map", "0:v:0", "-vf", "crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1",
    "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
  expect(rgb.length).toBe(18 * 3);
  for (let n = 0; n < 18; n++) {
    expect(rgb[n * 3 + 2]).toBeGreaterThan(220); expect(rgb[n * 3]).toBeLessThan(25);
  }
}
it.skipIf(!real)("documents unresolved late positive-origin audio content despite present AV, with a correct-clock control", async () => {
  // Literal test-only indices: source250.1 at48k, window.6. Neither seek
  // formatting nor metadata offsets determine the independent source reference.
  const selected = Buffer.alloc(28800 * 8), full = await open(path.join(dir, "mono-full.pcm"), "r");
  try { expect((await full.read(selected, 0, selected.length, 12004800 * 8)).bytesRead).toBe(selected.length); }
  finally { await full.close(); }
  const raw = path.join(dir, "late-reference.pcm"), reference = raw + ".m4a";
  await writeFile(raw, selected);
  ff(["-f", "f32le", "-ac", "2", "-ar", "48000", "-i", raw, "-c:a", "aac", "-movie_timescale", "48000", reference]);
  // AAC priming remains part of the positive-origin full decode. The fixed
  // .426..436 window is inside its expected .421333..441333 pulse.
  expect(rmsAt(decodedStereo(reference), 20448, 20928)).toBeGreaterThan(4000);
  for (const [name, input] of [["normal", normal], ["positive", positive]]) {
    const output = path.join(dir, `late-${name}.mp4`), inputIdentity = await containAudioInputIdentity(input);
    const sourceBytes = await readFile(input);
    await extractEditorSegment({ inputPath: input, outputPath: output, startSec: 250.1, endSec: 250.7 });
    const before = await readFile(output);
    expect((await probeMedia(output)).streams?.map(s => s.codec_type)).toEqual(["video", "audio"]);
    expect(await recoverSelectedSegmentAudio({ input, output, start: 250.1, end: 250.7, inputIdentity })).toBe("unchanged");
    expect((await readFile(output)).equals(before)).toBe(true);
    expect((await readFile(input)).equals(sourceBytes)).toBe(true); expectBlueFrames(output);
    const actual = decodedStereo(output);
    if (name === "normal") expect(rmsAt(actual, 19440, 19920)).toBeGreaterThan(4000); // fixed .405..415
    else expect(rmsAt(actual, 20448, 20928)).toBeLessThan(1500); // known unresolved mismatch, not successful recovery
    expect(rmsAt(actual, 9600, 10560)).toBeLessThan(1500);
  }
}, 30000);
it.skipIf(!real).each(["normal", "repaired", "exhausted"])("multipart %s preserves the later-part audio clock within one recovery attempt", async mode => {
  const missingFirst = mode !== "normal";
  const p = createEmptyProject(); p.compositionWidth = p.compositionHeight = 320; p.compositionDurationSec = .6;
  const a: Asset = { id: "matrix-first", kind: "video", ext: "mp4", displayName: "first", streamUrl: "/x", sourceDurationSec: 300 };
  const b: Asset = { ...a, id: "matrix-second", displayName: "second" };
  p.assets = [a, b]; sources.set(a.id, missingFirst ? positive : normal); sources.set(b.id, normal);
  const c: MediaClip = { id: "matrix", trackId: p.tracks[0].id, timelineStartSec: 0, durationSec: .6,
    transform: { x: .5, y: .5, scale: 1 }, parts: [
      { assetId: a.id, sourceInSec: .1, sourceOutSec: .4 }, { assetId: b.id, sourceInSec: .4, sourceOutSec: .7 },
    ] };
  p.clips = [c]; const saved = JSON.stringify(p), inputBytes = await Promise.all([normal, positive].map(f => readFile(f)));
  const jobDir = path.join(dir, `multipart-matrix-${mode}`); await mkdir(jobDir);
  const outputPath = path.join(jobDir, "out.mp4");
  await renderClipToFile({ clip: c, assets: p.assets, jobDir, outputPath, width: 320, height: 320,
    sourceAudioRecoveryBudget: { remaining: mode === "exhausted" ? 0 : 1 } });
  expectBlueFrames(outputPath); expect(JSON.stringify(p)).toBe(saved);
  const actual = decodedStereo(outputPath);
  if (mode === "exhausted") {
    // A used job budget preserves the legacy result, not synthetic silence.
    expect(actual.length / 4).toBe(15360);
    expect(actual.length / 4).toBeLessThan(19440);
    expect(rmsAt(actual, 5040, 5520)).toBeGreaterThan(4000);
  } else {
    expect(actual.length / 4).toBe(29696);
    expect(rmsAt(actual, 19440, 19920)).toBeGreaterThan(4000); // later normal pulse .405..415
    expect(rmsAt(actual, 5040, 5520)).toBeLessThan(1500); // no .3s advance
  }
  if (mode === "normal") {
    const legacy = path.join(jobDir, "legacy.mp4");
    await renderClipToFile({ clip: c, assets: p.assets, jobDir, outputPath: legacy, width: 320, height: 320,
      sourceAudioRecoveryBudget: { remaining: 0 } });
    expect((await readFile(outputPath)).equals(await readFile(legacy))).toBe(true);
    await rm(legacy);
  }
  if (mode === "repaired") {
    c.audioGain = 0; const savedMuted = JSON.stringify(p), mutedDir = path.join(dir, "muted-recovery"); await mkdir(mutedDir);
    const muted = path.join(mutedDir, "muted.mp4");
    await exportCompositionToFile({ project: p, jobDir: mutedDir, outputPath: muted });
    const silent = decodedStereo(muted); expect(silent.length / 4).toBe(29696);
    expect(silent.every(byte => byte === 0)).toBe(true); expectBlueFrames(muted);
    expect(await readdir(mutedDir)).toEqual(["muted.mp4"]);
    expect(JSON.stringify(p)).toBe(savedMuted); delete c.audioGain;
  }
  for (const [i, file] of [normal, positive].entries()) expect((await readFile(file)).equals(inputBytes[i])).toBe(true);
  expect(await readdir(jobDir)).toEqual(["out.mp4"]);
}, 30000);
