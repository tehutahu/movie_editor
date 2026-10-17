import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Asset, Clip, EditorProject } from "./editor/types";
import { createEmptyProject } from "./editor/project";
import { exportCompositionToFile } from "./exportComposition";
import { renderClipToFile } from "./renderClip";
const state = vi.hoisted(() => ({ sources: new Map<string, string>(), calls: [] as string[][] }));
vi.mock("@/lib/assetResolve", () => ({ resolveAssetInputPath: async (a: Asset) => state.sources.get(a.id) ?? null }));
vi.mock("@/lib/ffmpeg", async importOriginal => {
  const actual = await importOriginal<typeof import("./ffmpeg")>();
  return { ...actual, runFfmpegCommand: async (...args: Parameters<typeof actual.runFfmpegCommand>) => {
    state.calls.push([...args[0]]); await actual.runFfmpegCommand(...args);
    const output = args[0].at(-1)!;
    if (/part_0(?:_source_\d+)?\.mp4$/.test(output)) await copyFile(output, `${output}.keep`);
  } };
});
const real = process.env.RUN_FFMPEG_TESTS === "1";
let root: string, project: EditorProject;
function ff(args: string[], input?: Buffer) {
  return execFileSync(process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg", ["-v", "error", "-y", ...args], { input, maxBuffer: 64 * 1024 * 1024 });
}
function raw(file: string, audio = false): Buffer {
  return ff(["-i", file, "-map", audio ? "0:a:0" : "0:v:0", ...(audio ? ["-f", "s16le"] : ["-pix_fmt", "rgb24", "-f", "rawvideo"]), "pipe:1"]);
}
function readFrame(data: Buffer, n: number) {
  const frame = data.subarray(n * 320 * 320 * 3, (n + 1) * 320 * 320 * 3);
  const id = Array.from({ length: 7 }, (_, b) => frame[(160 * 320 + Math.floor((16 + b * 32) / 240 * 320)) * 3] > 128 ? 2 ** b : 0).reduce((s, b) => s + b, 0);
  const mark = [...frame.subarray((300 * 320 + 160) * 3, (300 * 320 + 160) * 3 + 3)];
  return { id, asset: mark[0] > mark[2] ? "A" : "B" };
}
function clip(start: number, aIn: number, aOut: number): Clip {
  return { id: randomUUID(), trackId: project.tracks[0].id, timelineStartSec: start, durationSec: aOut - aIn + 1,
    parts: [{ assetId: project.assets[0].id, sourceInSec: aIn, sourceOutSec: aOut }, { assetId: project.assets[1].id, sourceInSec: .5, sourceOutSec: 1.5 }], transform: { x: .5, y: .5, scale: 2 } };
}
async function exportCase(name: string, c: Clip) {
  const dir = path.join(root, name); await mkdir(dir); state.calls.length = 0;
  const output = path.join(dir, "new.mp4");
  await exportCompositionToFile({ project: { ...project, clips: [c], compositionDurationSec: 4 }, jobDir: dir, outputPath: output });
  await writeFile(path.join(dir, "commands.json"), JSON.stringify(state.calls, null, 2));
  return { dir, output, calls: state.calls.map(args => [...args]) };
}
/** Exact former AV-concat graph, using the same captured normalized sources and final graph. */
function legacyCase(c: Clip, result: Awaited<ReturnType<typeof exportCase>>) {
  const prepared = path.join(result.dir, "part_0.mp4"), oldPart = path.join(result.dir, "legacy-part.mp4"), oldOutput = path.join(result.dir, "legacy.mp4");
  const concatCall = result.calls.find(args => args.includes(prepared))!;
  const filters = c.parts.flatMap((p, i) => [`[${i}:v]trim=duration=${p.sourceOutSec - p.sourceInSec},setpts=PTS-STARTPTS[v${i}]`, `[${i}:a]atrim=duration=${p.sourceOutSec - p.sourceInSec},asetpts=PTS-STARTPTS[a${i}]`]);
  filters.push("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]");
  ff(["-i", path.join(result.dir, "part_0_source_0.mp4.keep"), "-i", path.join(result.dir, "part_0_source_1.mp4.keep"), "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-t", String(c.durationSec), "-movflags", "+faststart", oldPart]);
  expect(concatCall).toBeDefined();
  const finalCall = result.calls.at(-1)!.map(arg => arg === prepared ? oldPart : arg === result.output ? oldOutput : arg);
  ff(finalCall); return oldOutput;
}
beforeAll(async () => {
  if (!real) return;
  const evidence = process.env.MULTIPART_TEST_ARTIFACT_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  root = await mkdtemp(path.join(evidence ?? tmpdir(), "multipart-boundary-")); project = createEmptyProject(); project.compositionWidth = project.compositionHeight = 320;
  for (const [i, fps] of [24, 30].entries()) {
    const frames = fps * 3, buffer = Buffer.alloc(240 * 120 * 3 * frames);
    for (let n = 0; n < frames; n++) for (let y = 0; y < 120; y++) for (let x = 0; x < 240; x++) {
      const at = ((n * 120 + y) * 240 + x) * 3, value = (n >> Math.floor(x / 32)) & 1 ? 224 : 32;
      buffer[at] = buffer[at + 1] = buffer[at + 2] = value;
      if (y >= 100) { buffer[at] = i === 0 ? 240 : 0; buffer[at + 1] = 0; buffer[at + 2] = i === 1 ? 240 : 0; }
    }
    const file = path.join(root, `${fps}.mp4`), id = randomUUID();
    ff(["-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "240x120", "-framerate", String(fps), "-i", "pipe:0", "-f", "lavfi", "-i", `sine=frequency=${i ? 880 : 440}:sample_rate=48000:duration=3`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file], buffer);
    state.sources.set(id, file); project.assets.push({ id, kind: "video", ext: "mp4", streamUrl: "/unused", displayName: String(fps), sourceDurationSec: 3 });
  }
}, 30000);
afterAll(async () => { if (root && !process.env.MULTIPART_TEST_ARTIFACT_DIR) await rm(root, { recursive: true, force: true }); });
it.skipIf(!real)("real ffmpeg: fixes the captured mixed-fps boundary and retains the initial source phase", async () => {
  const c = clip(1.75, 1, 1.25), result = await exportCase("target", c), video = raw(result.output);
  expect(readFrame(video, 53)).toEqual({ id: 24, asset: "A" });
  expect(readFrame(video, 59)).toEqual({ id: 29, asset: "A" });
  expect(readFrame(video, 60)).toEqual({ id: 15, asset: "B" });
  expect(readFrame(video, 75)).toEqual({ id: 30, asset: "B" });
  const old = raw(legacyCase(c, result));
  expect(readFrame(old, 60)).toEqual({ id: 29, asset: "A" });
  expect(readFrame(old, 75)).toEqual({ id: 29, asset: "B" });
}, 120000);
it.skipIf(!real)("real ffmpeg: preserves all decoded RGB and PCM at an already-correct frame-aligned part duration", async () => {
  const c = clip(1.75, 1, 1.2), result = await exportCase("compatible", c), old = legacyCase(c, result);
  expect(raw(result.output).equals(raw(old))).toBe(true);
  expect(raw(result.output, true).equals(raw(old, true))).toBe(true);
}, 120000);
it.skipIf(!real)("real ffmpeg: ordinary nongrid and true subtick grid-after boundaries retain the intended owner", async () => {
  for (const [name, start, out, sample, owner] of [["ordinary", 1.75, .23, 59, "A"], ["after-grid", 0, .3000000001, 9, "A"]] as const) {
    const result = await exportCase(name, clip(start, 0, out));
    expect(readFrame(raw(result.output), sample).asset).toBe(owner);
    expect(readFrame(raw(result.output), sample + 1).asset).toBe("B");
  }
}, 120000);
it.skipIf(!real)("real ffmpeg: no-sample micro part keeps the model while a required missing frame fails and cleans sources", async () => {
  for (const start of [.17, 0]) {
    const c = clip(start, 0, 1e-10), before = structuredClone(c), dir = path.join(root, `micro-${start}`); await mkdir(dir);
    const render = renderClipToFile({ clip: c, assets: project.assets, jobDir: dir, outputPath: path.join(dir, "part.mp4"), width: 320, height: 320 });
    if (start === 0) await expect(render).rejects.toThrow(/必要な映像フレーム/);
    else await render;
    expect(c).toEqual(before);
    expect((await readdir(dir)).filter(f => /_source_\d+\.mp4$/.test(f))).toEqual([]);
  }
}, 120000);
it.skipIf(!real)("real ffmpeg: repeats only the final available legacy frame at a short nonempty EOF", async () => {
  const c = clip(0, 2.94, 3), result = await exportCase("short-eof", c), video = raw(result.output);
  expect(readFrame(video, 0)).toEqual({ id: 71, asset: "A" });
  expect(readFrame(video, 1)).toEqual({ id: 71, asset: "A" });
  expect(readFrame(video, 2)).toEqual({ id: 15, asset: "B" });
}, 120000);
it.skipIf(!real)("real ffmpeg: selected multipart uses its zero-based frame phase and mixed contain keeps stretch ownership", async () => {
  const selected = clip(0, 1, 1.25), dir = path.join(root, "selected"); await mkdir(dir);
  const output = path.join(dir, "selected.mp4");
  await renderClipToFile({ clip: selected, assets: project.assets, jobDir: dir, outputPath: output, width: 320, height: 320 });
  const source = raw(output);
  expect(readFrame(source, 7).asset).toBe("A"); expect(readFrame(source, 8)).toEqual({ id: 15, asset: "B" });
  const c = clip(1.75, 1, 1.25), mixedDir = path.join(root, "mixed"); await mkdir(mixedDir);
  const contain: Clip = { ...clip(0, 0, .25), id: randomUUID(), layoutMode: "contain", timelineStartSec: 0, durationSec: 1,
    parts: [{ assetId: project.assets[1].id, sourceInSec: 0, sourceOutSec: 1 }], transform: { x: -2, y: .5, scale: .1 } };
  const mixed = path.join(mixedDir, "mixed.mp4");
  await exportCompositionToFile({ project: { ...project, clips: [c, contain], compositionDurationSec: 4 }, jobDir: mixedDir, outputPath: mixed });
  const video = raw(mixed);
  expect(readFrame(video, 60)).toEqual({ id: 15, asset: "B" }); expect(readFrame(video, 75)).toEqual({ id: 30, asset: "B" });
}, 120000);
it.skipIf(!real)("real ffmpeg: 50 parts preserve the independently concatenated legacy PCM and bounded frame count", async () => {
  const c: Clip = { ...clip(.17, 0, .05001), durationSec: 2.5005,
    parts: Array.from({ length: 50 }, () => ({ assetId: project.assets[0].id, sourceInSec: 0, sourceOutSec: .05001 })) };
  const dir = path.join(root, "fifty"); await mkdir(dir); state.calls.length = 0;
  const output = path.join(dir, "part_0.mp4");
  await renderClipToFile({ clip: c, assets: project.assets, jobDir: dir, outputPath: output, width: 64, height: 64 });
  const join = state.calls.at(-1)!;
  const inputs = Array.from({ length: 50 }, (_, i) => path.join(dir, `part_0_source_${i}.mp4.keep`));
  const graph = join[join.indexOf("-filter_complex") + 1];
  const audioGraph = graph.split(";").filter(f => /\[\d+:a\]|:v=0:a=1/.test(f)).join(";");
  const audio = ff([...inputs.flatMap(file => ["-i", file]), "-filter_complex", audioGraph, "-map", "[a]", "-f", "s16le", "pipe:1"]);
  // Read-only PCM oracle uses the original decoded/trimmed stream, never video duration.
  const one = ff(["-i", inputs[0], "-af", "atrim=duration=0.05001,asetpts=PTS-STARTPTS", "-f", "s16le", "pipe:1"]);
  expect(audio.equals(Buffer.concat(Array(50).fill(one)))).toBe(true);
  expect(audio.length / 4).toBe(120000); // measured 48k fixture: nominal 120024; existing per-part rounding stays explicit
  const frames = ff(["-i", output, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  expect(frames.length / (64 * 64 * 3)).toBe(75);
}, 120000);
