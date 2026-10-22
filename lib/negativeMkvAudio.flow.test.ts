import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const mocked = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./containAudioRepair", async original => ({ ...await original<typeof import("./containAudioRepair")>(), runBoundedAudioAux: mocked.run }));
import { negativeMkvPreviewAudio } from "./negativeMkvAudio";
let dir: string, files: string[], candidates: string[];
const hash = `SHA256:${"a".repeat(64)}`;
const sourceProbe = { format: { format_name: "matroska,webm", start_time: "-0.221000", duration: "0.020000" }, streams: [
  { codec_type: "video", codec_name: "h264", time_base: "1/1000", start_pts: 0, start_time: "0.000000", avg_frame_rate: "30/1", r_frame_rate: "30/1" },
  { codec_type: "audio", codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 1, time_base: "1/1000", start_pts: -221, start_time: "-0.221000" },
] };
async function normal(_command: string, args: string[]) {
  const derived = args.at(-1)!.endsWith("audio.m4a");
  if (args.includes("-show_streams")) return JSON.stringify(derived ? { streams: [{ ...sourceProbe.streams[1], time_base: "1/48000", start_pts: 0, start_time: "0.000000", duration_ts: 1024 }] } : sourceProbe);
  if (args.includes("-show_packets")) return JSON.stringify({ packets: [{ pts: derived ? 0 : -221, dts: derived ? 0 : -221, duration: derived ? 1024 : 21, data_hash: hash }] });
  if (args.includes("framemd5")) return `0, 0, 0, 1024, 8192, ${"b".repeat(64)}\n`;
  candidates.push(args.at(-1)!); await writeFile(args.at(-1)!, "candidate"); return "";
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "negative-mkv-flow-")); files = [0, 1, 2].map(i => path.join(dir, `${i}.mkv`));
  await Promise.all(files.map(f => writeFile(f, "input"))); candidates = []; mocked.run.mockReset().mockImplementation(normal);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
it("coalesces one identity, bounds concurrent work, and releases both slots", async () => {
  const releases: (() => void)[] = [];
  mocked.run.mockImplementation(async (command, args) => { if (args.includes("-show_streams") && !args.at(-1).endsWith("audio.m4a")) await new Promise<void>(r => releases.push(r)); return normal(command, args); });
  const first = negativeMkvPreviewAudio(files[0]), same = negativeMkvPreviewAudio(files[0]), second = negativeMkvPreviewAudio(files[1]);
  await vi.waitFor(() => expect(releases).toHaveLength(2)); expect(await negativeMkvPreviewAudio(files[2])).toBeNull();
  for (const release of releases) release();
  const outputs = await Promise.all([first, same, second]); expect(outputs.map(b => b?.toString())).toEqual(["candidate", "candidate", "candidate"]); expect(candidates).toHaveLength(2);
  for (const file of candidates) await expect(access(path.dirname(file))).rejects.toThrow();
  mocked.run.mockImplementation(normal); expect((await negativeMkvPreviewAudio(files[2]))?.toString()).toBe("candidate");
});
it("failed candidate diagnostics reclaim the unique temp directory and retain original bytes", async () => {
  mocked.run.mockImplementation(async (command, args) => { if (args.includes("-show_streams") && args.at(-1).endsWith("audio.m4a")) throw Error("probe timeout"); return normal(command, args); });
  expect(await negativeMkvPreviewAudio(files[0])).toBeNull(); expect(candidates).toHaveLength(1); await expect(access(path.dirname(candidates[0]))).rejects.toThrow();
});
it("a changed input after decoded proof cannot publish candidate bytes", async () => {
  mocked.run.mockImplementation(async (command, args) => { const result = await normal(command, args); if (args.includes("framemd5") && args.includes(path.join(path.dirname(candidates[0] ?? "unused"), "audio.m4a"))) await writeFile(files[0], "replacement"); return result; });
  expect(await negativeMkvPreviewAudio(files[0])).toBeNull(); expect(candidates).toHaveLength(1); await expect(access(path.dirname(candidates[0]))).rejects.toThrow();
});
