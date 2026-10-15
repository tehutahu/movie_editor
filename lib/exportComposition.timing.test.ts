import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyProject } from "./editor/project";
import { parseCompositionExportPayload } from "./editor/validateExportProject";
import { resolveActiveClipsAtPlayhead, transformToPixelRect } from "./editor/compositor";
import { exportCompositionToFile } from "./exportComposition";
import { probeVideo } from "./ffmpeg";
import type { Asset, Clip, ClipTransform, EditorProject } from "./editor/types";

const sources = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/assetResolve", () => ({ resolveAssetInputPath: async (a: Asset) => sources.get(a.id) ?? null }));
const real = process.env.RUN_FFMPEG_TESTS === "1";
let dir: string;
let asset: Asset;
function ff(args: string[]) {
  return execFileSync(process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg", ["-v", "error", "-y", ...args]);
}
function pixel(file: string, time: number, x = 160, y = 160) {
  return ff(["-ss", String(time), "-i", file, "-frames:v", "1", "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
}
function colour(file: string, time: number, channel: number, x = 160, y = 160) {
  const rgb = pixel(file, time, x, y);
  expect(rgb.length).toBe(3);
  expect(rgb[channel], `RGB ${[...rgb]} at ${time}s`).toBeGreaterThan(100);
  expect(rgb[channel]! - rgb[(channel + 1) % 3]!).toBeGreaterThan(80);
}
function silent(file: string, time: number, audible = false) {
  const pcm = ff(["-ss", String(time), "-i", file, "-t", "0.15", "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"]);
  expect(pcm.length).toBeGreaterThan(1000);
  let energy = 0;
  for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  const rms = Math.sqrt(energy / (pcm.length / 2));
  if (audible) expect(rms).toBeGreaterThan(500);
  else expect(rms).toBeLessThan(50);
}
function projectAt(start: number, transform: ClipTransform = { x: .5, y: .5, scale: 2 }) {
  const p = createEmptyProject();
  p.tracks = [p.tracks[1]!];
  p.assets = [asset]; p.compositionWidth = 320; p.compositionHeight = 320;
  p.compositionDurationSec = start + 3;
  p.clips = [{ id: randomUUID(), trackId: p.tracks[0]!.id, timelineStartSec: start, durationSec: 2,
    parts: [{ assetId: asset.id, sourceInSec: .5, sourceOutSec: 2.5 }], transform }];
  return parseCompositionExportPayload(p).project;
}
async function render(p: EditorProject) {
  const jobDir = path.join(dir, randomUUID()); await mkdir(jobDir);
  const outputPath = path.join(jobDir, "out.mp4");
  await exportCompositionToFile({ project: p, jobDir, outputPath });
  expect((await probeVideo(outputPath)).durationSec).toBeCloseTo(p.compositionDurationSec, 1);
  return outputPath;
}
beforeAll(async () => {
  if (!real) return;
  dir = await mkdtemp(path.join(tmpdir(), "composition-timing-"));
  const file = path.join(dir, "clock.mp4");
  // Source clock: red/silent, blue/tone, green/silent, each exactly one second.
  ff(["-f", "lavfi", "-i", "color=red:s=320x320:r=30:d=1", "-f", "lavfi", "-i", "color=blue:s=320x320:r=30:d=1", "-f", "lavfi", "-i", "color=green:s=320x320:r=30:d=1",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=3",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a]volume=enable='lt(t,1)+gte(t,2)':volume=0[a]",
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-c:a", "aac", file]);
  asset = { id: randomUUID(), kind: "video", ext: "mp4", displayName: "source clock", streamUrl: "/x", sourceDurationSec: 3, width: 320, height: 320 };
  sources.set(asset.id, file);
}, 30000);
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

it.skipIf(!real).each([0, 10, 10.25])("real ffmpeg #17: source clock and audio at timeline start %s", async (start) => {
  const p = projectAt(start);
  const out = await render(p);
  for (const [offset, channel] of [[.2, 0], [.7, 2], [1.7, 1]]) {
    const layer = resolveActiveClipsAtPlayhead(p, start + offset!)![0]!;
    expect(layer.sourceTimeSec).toBeCloseTo(.5 + offset!, 6);
    colour(out, start + offset!, channel!);
  }
  silent(out, start + .15); silent(out, start + .7, true); silent(out, start + 1.7);
  if (start) {
    expect([...pixel(out, start - 1 / 30)].every(v => v < 25)).toBe(true);
    silent(out, start - .3);
  }
  expect([...pixel(out, start + 2)].every(v => v < 25)).toBe(true);
}, 120000);

it.skipIf(!real)("real ffmpeg #17: adjacent boundary and multiple tracks match preview", async () => {
  const p = projectAt(2);
  const lower = { id: randomUUID(), order: 1 }; p.tracks.push(lower);
  const upper = p.clips[0]!;
  const background: Clip = { ...upper, id: randomUUID(), trackId: lower.id, timelineStartSec: 0, durationSec: 5,
    parts: [{ assetId: asset.id, sourceInSec: 0, sourceOutSec: 1 }, { assetId: asset.id, sourceInSec: 2, sourceOutSec: 3 }, { assetId: asset.id, sourceInSec: 0, sourceOutSec: 3 }] };
  const adjacent: Clip = { ...upper, id: randomUUID(), timelineStartSec: 4, durationSec: 1,
    parts: [{ assetId: asset.id, sourceInSec: 0, sourceOutSec: 1 }] };
  p.clips.push(background, adjacent);
  const out = await render(parseCompositionExportPayload(p).project);
  colour(out, 1.5, 1); colour(out, 2, 0); colour(out, 2.7, 2); colour(out, 3.7, 1);
  colour(out, 4, 0); colour(out, 4.2, 0);
  silent(out, 1); silent(out, 2.7, true); silent(out, 4.2);
}, 120000);

it.skipIf(!real).each([
  { x: .5, y: .5, scale: 3 },
  { x: 0, y: .5, scale: 1 }, { x: 1, y: .5, scale: 1 },
  { x: .5, y: 0, scale: 1 }, { x: .5, y: 1, scale: 1 },
  { x: 0, y: 0, scale: 1 },
  { x: -.1, y: .5, scale: 1 }, { x: 1.1, y: .5, scale: 1 },
  { x: .5, y: -.1, scale: 1 }, { x: .5, y: 1.1, scale: 1 },
  { x: -1e300, y: 1e300, scale: 3 },
])("real ffmpeg #18: crops off-canvas transform %j", async (transform) => {
  const p = projectAt(0, transform);
  const out = await render(p);
  const r = transformToPixelRect(transform, 320, 320);
  for (const x of [20, 160, 300]) for (const y of [20, 160, 300]) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) colour(out, .2, 0, x, y);
    else expect([...pixel(out, .2, x, y)].every(v => v < 25)).toBe(true);
  }
}, 120000);

it.skipIf(!real).each([99.999, 100, 100.001, 101, 180.25])("real ffmpeg #19: delayed video/audio at %ss", async (start) => {
  const out = await render(projectAt(start));
  expect([...pixel(out, start - .1)].every(v => v < 25)).toBe(true);
  colour(out, start + .2, 0); colour(out, start + .8, 2); colour(out, start + 1.8, 1);
  silent(out, start - .3); silent(out, start + .15); silent(out, start + .8, true); silent(out, start + 1.8);
}, 120000);

it.skipIf(!real)("real ffmpeg #17/#20: later multipart clip retains source order and delayed tone", async () => {
  const p = projectAt(10);
  p.clips[0]!.parts = [
    { assetId: asset.id, sourceInSec: 2, sourceOutSec: 3 },
    { assetId: asset.id, sourceInSec: 1, sourceOutSec: 2 },
  ];
  const out = await render(p);
  colour(out, 10.2, 1); colour(out, 11.2, 2);
  silent(out, 9.7); silent(out, 10.2); silent(out, 11.2, true);
  expect([...pixel(out, 12)].every(v => v < 25)).toBe(true);
}, 120000);
