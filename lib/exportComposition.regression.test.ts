import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyProject } from "./editor/project";
import { selectedClipExportRequest } from "./editor/selectedClipExport";
import { parseCompositionExportPayload } from "./editor/validateExportProject";
import { exportCompositionToFile } from "./exportComposition";
import { probeVideo } from "./ffmpeg";
import type { Asset, Clip, EditorProject } from "./editor/types";
const sources = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/assetResolve", () => ({ resolveAssetInputPath: async (a: Asset) => sources.get(a.id) ?? null }));
const real = process.env.RUN_FFMPEG_TESTS === "1";
let dir: string;
let p: EditorProject;
let clip: Clip;
function ff(args: string[]) { return execFileSync(process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg", ["-v", "error", "-y", ...args]); }
beforeAll(async () => {
  if (!real) return;
  dir = await mkdtemp(path.join(tmpdir(), "merged-export-"));
  const red = path.join(dir, "red.mp4"), blue = path.join(dir, "blue.mp4"), green = path.join(dir, "green.png");
  ff(["-f", "lavfi", "-i", "color=red:s=320x320:r=24:d=3", "-c:v", "libx264", red]);
  ff(["-f", "lavfi", "-i", "color=blue:s=480x320:r=30:d=3", "-f", "lavfi", "-i", "sine=frequency=880:duration=3", "-c:v", "libx264", "-c:a", "aac", blue]);
  ff(["-f", "lavfi", "-i", "color=green:s=640x360", "-frames:v", "1", green]);
  p = createEmptyProject(); p.compositionWidth = 320; p.compositionHeight = 320;
  p.assets = [red, green, blue].map((file, i) => {
    const id = randomUUID(); sources.set(id, file);
    return { id, kind: i === 1 ? "image" : "video", ext: i === 1 ? "png" : "mp4", displayName: file, streamUrl: "/x", sourceDurationSec: i === 1 ? undefined : 3, width: 320, height: 320 };
  });
  clip = { id: randomUUID(), trackId: p.tracks[0]!.id, timelineStartSec: 7, durationSec: 3,
    parts: p.assets.map((a) => ({ assetId: a.id, sourceInSec: 1, sourceOutSec: 2 })), transform: { x: .5, y: .5, scale: 1 } };
}, 30000);
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
it.skipIf(!real)("real ffmpeg: mixed video/image/video keeps order, length, later audio and noncontiguous ranges #20", async () => {
  const request = selectedClipExportRequest(p, clip);
  const project = parseCompositionExportPayload(request.body).project;
  // Keep the smoke test small; the same export pipeline handles all canvas sizes.
  project.compositionWidth = 320; project.compositionHeight = 320;
  const jobDir = path.join(dir, "mixed"); await mkdir(jobDir);
  const output = path.join(jobDir, "out.mp4");
  await exportCompositionToFile({ project, jobDir, outputPath: output });
  const probe = await probeVideo(output);
  expect(probe.durationSec).toBeCloseTo(3, 1); expect(probe.hasAudio).toBe(true);
  for (const [time, channel] of [[.4, 0], [1.4, 1], [2.4, 2]]) {
    const rgb = ff(["-ss", String(time), "-i", output, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    expect(rgb[channel]!).toBeGreaterThan(80);
    expect(rgb[channel]!).toBeGreaterThan(rgb[(channel! + 1) % 3]! + 60);
  }
  // Same source, disjoint ranges: blue then red is represented by changing
  // the first source fixture to a two-colour video.
  const twoColour = path.join(dir, "two.mp4");
  ff(["-f", "lavfi", "-i", "color=red:s=320x320:r=30:d=1", "-f", "lavfi", "-i", "color=blue:s=320x320:r=30:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", twoColour]);
  sources.set(p.assets[0]!.id, twoColour);
  const c = { ...clip, durationSec: 1, parts: [{ assetId: p.assets[0]!.id, sourceInSec: 1.2, sourceOutSec: 1.7 }, { assetId: p.assets[0]!.id, sourceInSec: .2, sourceOutSec: .7 }] };
  const disjoint = parseCompositionExportPayload(selectedClipExportRequest(p, c).body).project;
  disjoint.compositionWidth = 320; disjoint.compositionHeight = 320;
  const other = path.join(dir, "disjoint"); await mkdir(other);
  const out = path.join(other, "out.mp4");
  await exportCompositionToFile({ project: disjoint, jobDir: other, outputPath: out });
  expect((await probeVideo(out)).durationSec).toBeCloseTo(1, 1);
  const start = ff(["-ss", "0.2", "-i", out, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  const end = ff(["-ss", "0.7", "-i", out, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  expect(start[2]).toBeGreaterThan(180); expect(end[0]).toBeGreaterThan(180);
  sources.set(p.assets[0]!.id, path.join(dir, "red.mp4"));
}, 120000);
it("rejects missing input, instead of silently skipping a clip", async () => {
  const project = createEmptyProject(); const id = randomUUID();
  project.assets = [{ id, kind: "video", ext: "mp4", displayName: "missing", streamUrl: "/x" }];
  project.clips = [{ id: randomUUID(), trackId: project.tracks[0]!.id, timelineStartSec: 0, durationSec: 1, parts: [{ assetId: id, sourceInSec: 0, sourceOutSec: 1 }], transform: { x: .5, y: .5, scale: 1 } }];
  await expect(exportCompositionToFile({ project, jobDir: "/unused", outputPath: "/unused/out" })).rejects.toThrow(/素材/);
});

it.skipIf(!real)("real ffmpeg: image-first clip retains later video/audio; image-only export is timed", async () => {
  const imageFirst = { ...clip, durationSec: 2, parts: [clip.parts[1]!, clip.parts[2]!] };
  const project = parseCompositionExportPayload(selectedClipExportRequest(p, imageFirst).body).project;
  project.compositionWidth = 320; project.compositionHeight = 320;
  const jobDir = path.join(dir, "image-first"); await mkdir(jobDir);
  const output = path.join(jobDir, "out.mp4");
  await exportCompositionToFile({ project, jobDir, outputPath: output });
  const info = await probeVideo(output);
  expect(info.durationSec).toBeCloseTo(2, 1); expect(info.hasAudio).toBe(true);
  const pcm = ff(["-ss", "1.2", "-i", output, "-t", "0.3", "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"]);
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  expect(Math.sqrt(energy / (pcm.length / 2))).toBeGreaterThan(500);
  const onlyImage = { ...imageFirst, durationSec: 1, parts: [clip.parts[1]!] };
  const stillProject = parseCompositionExportPayload(selectedClipExportRequest(p, onlyImage).body).project;
  stillProject.compositionWidth = 320; stillProject.compositionHeight = 320;
  const stillDir = path.join(dir, "image-only"); await mkdir(stillDir);
  const stillOutput = path.join(stillDir, "out.mp4");
  await exportCompositionToFile({ project: stillProject, jobDir: stillDir, outputPath: stillOutput });
  expect((await probeVideo(stillOutput)).durationSec).toBeCloseTo(1, 1);
  const rgb = ff(["-ss", "0.5", "-i", stillOutput, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  expect(rgb[1]).toBeGreaterThan(100);
}, 120000);
it.skipIf(!real)("real ffmpeg: missing later source and out-of-range parts fail instead of partial success", async () => {
  const project = parseCompositionExportPayload(selectedClipExportRequest(p, clip).body).project;
  const jobDir = path.join(dir, "missing-later"); await mkdir(jobDir);
  const source = sources.get(p.assets[1]!.id)!;
  sources.delete(p.assets[1]!.id);
  await expect(exportCompositionToFile({ project, jobDir, outputPath: path.join(jobDir, "out.mp4") })).rejects.toThrow(/素材/);
  sources.set(p.assets[1]!.id, source);
  // Keep the model duration consistent so this isolates the media-range guard.
  project.clips[0]!.durationSec += 100 - project.clips[0]!.parts[2]!.sourceOutSec;
  project.clips[0]!.parts[2]!.sourceOutSec = 100;
  await expect(exportCompositionToFile({ project, jobDir, outputPath: path.join(jobDir, "out.mp4") })).rejects.toThrow(/長さ/);
}, 120000);
