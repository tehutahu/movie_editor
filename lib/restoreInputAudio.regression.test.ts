import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeRestoreInputAudio } from "./restoreInputAudio";
const real = process.env.RUN_FFMPEG_TESTS === "1";
let dir: string;
function create(name: string, rates: number[]) {
  const file = path.join(dir, `${name}.mp4`);
  execFileSync(process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=80x64:r=30:d=0.2",
    ...rates.flatMap(rate => ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${rate}:duration=0.2`]),
    "-map", "0:v", ...rates.flatMap((_, i) => ["-map", `${i + 1}:a`]), "-c:v", "libx264", "-c:a", "aac",
    ...(rates.length === 2 ? ["-disposition:a:0", "0", "-disposition:a:1", "default"] : []), file]);
  return file;
}
beforeAll(async () => { if (real) dir = await mkdtemp(path.join(tmpdir(), "restore-audio-descriptor-")); });
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
it.skipIf(!real).each([32000, 44100, 48000])("real ffprobe: observes input rate %s without resampling", async rate => {
  expect(await probeRestoreInputAudio(create(String(rate), [rate]))).toEqual({ status: "known", streamOrdinal: 0, streamIndex: 1, sampleRateHz: rate });
});
it.skipIf(!real).each([[44100, 48000], [48000, 44100]])("real ffprobe: a:0=%s wins over default a:1=%s", async (first, second) => {
  expect(await probeRestoreInputAudio(create(`${first}-${second}`, [first, second]))).toEqual({ status: "known", streamOrdinal: 0, streamIndex: 1, sampleRateHz: first });
});
it.skipIf(!real)("real ffprobe: audio-less input remains distinct from an unknown rate", async () => {
  expect(await probeRestoreInputAudio(create("silent", []))).toEqual({ status: "none" });
});
