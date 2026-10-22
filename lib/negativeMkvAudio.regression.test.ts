import { beforeAll, afterAll, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { negativeMkvPreviewAudio } from "./negativeMkvAudio";
import { resolveFfmpegPath, resolveFfprobePath } from "./ffmpeg";
const real = process.env.RUN_FFMPEG_TESTS === "1";
let dir: string;
const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024 });
const pcm = (file: string) => ff(["-xerror", "-i", file, "-map", "0:a:0", "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"]);
async function source(name: string, offset = "-0.2", stereo = false, audioDuration = "2") {
  const file = path.join(dir, name), webm = name.endsWith("webm");
  const signal = "0.035*sin(2*PI*440*t)+0.35*sin(2*PI*2000*t)*gte(t\\,0.5)*lt(t\\,0.52)";
  ff(["-f", "lavfi", "-i", "color=red:s=64x64:r=30:d=2", "-f", "lavfi", "-i", `aevalsrc=${signal}${stereo ? "|0.02*sin(2*PI*660*t)" : ""}:s=48000:d=${audioDuration}`, "-af", `asetpts=PTS+(${offset})/TB`, "-c:v", webm ? "libvpx-vp9" : "libx264", "-c:a", webm ? "libopus" : "aac", "-bf", "0", "-fps_mode", "passthrough", "-avoid_negative_ts", "disabled", file]);
  return file;
}
beforeAll(async () => { if (real) dir = await mkdtemp(path.join(tmpdir(), "negative-mkv-test-")); });
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

it.skipIf(!real).each([false, true])("negative MKV stereo=%s keeps every source PCM sample and all packet payloads on exact normalized clock", async stereo => {
  const file = await source(`negative-${stereo}.mkv`, "-0.2", stereo), before = await readFile(file);
  const audio = await negativeMkvPreviewAudio(file); expect(audio).not.toBeNull();
  const out = path.join(dir, `normalized-${stereo}.m4a`); await writeFile(out, audio!);
  expect(pcm(out).equals(pcm(file))).toBe(true);
  expect(pcm(out).length).toBe(97280 * 8);
  const packets = (f: string) => JSON.parse(execFileSync(resolveFfprobePath(), ["-v", "error", "-select_streams", "a:0", "-show_packets", "-show_entries", "packet=pts,duration,data_hash", "-show_data_hash", "sha256", "-of", "json", f], { encoding: "utf8" })).packets;
  const original = packets(file), derived = packets(out);
  expect(original[0].pts).toBe(-221);
  expect(derived.map((p: { data_hash: string }) => p.data_hash)).toEqual(original.map((p: { data_hash: string }) => p.data_hash));
  for (const [i, p] of derived.entries()) { expect(p.pts).toBe(i * 1024); expect(p.duration).toBe(1024); }
  expect((await readFile(file)).equals(before)).toBe(true);
  expect((await negativeMkvPreviewAudio(file))?.equals(audio!)).toBe(true);
}, 30000);

it.skipIf(!real)("shorter audio cannot introduce EOF restart inside the legal source range", async () => {
  const file = await source("short-audio.mkv", "-0.2", false, "1"); expect(await negativeMkvPreviewAudio(file)).toBeNull();
}, 30000);

it.skipIf(!real).each(["healthy.mkv", "negative.webm", "negative.mp4"])("%s remains on original bytes", async name => {
  const file = await source(name, name === "healthy.mkv" ? "0" : "-0.2"), bytes = await readFile(file);
  expect(await negativeMkvPreviewAudio(file)).toBeNull(); expect((await readFile(file)).equals(bytes)).toBe(true);
}, 30000);

it.skipIf(!real)("same-path replacement invalidates cached derived bytes and corrupt inputs cleanly fall back", async () => {
  const file = await source("replacement.mkv"); expect(await negativeMkvPreviewAudio(file)).not.toBeNull();
  await writeFile(file, "not media"); expect(await negativeMkvPreviewAudio(file)).toBeNull();
  expect(await readdir(dir)).not.toContain("audio.m4a");
}, 30000);

it.skipIf(!real)("a timestamp gap is rejected even though flattening preserves every decoded sample", async () => {
  const file = await source("gap-base.mkv"), gap = path.join(dir, "gap.mkv");
  ff(["-copyts", "-i", file, "-map", "0", "-c", "copy", "-bsf:a", "setts=pts=PTS+gte(N\\,40)*1000:dts=DTS+gte(N\\,40)*1000", "-avoid_negative_ts", "disabled", gap]);
  expect(pcm(gap).equals(pcm(file))).toBe(true); expect(await negativeMkvPreviewAudio(gap)).toBeNull();
}, 30000);
