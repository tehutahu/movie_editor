import { beforeEach, expect, it, vi } from "vitest";
import { AudioAuxAbort, AudioAuxCleanupError } from "./containAudioRepair";
import { recoverSelectedSegmentAudio, SELECTED_AUDIO_RECOVERY_LIMITS } from "./selectedSegmentAudio";
const mocks = vi.hoisted(() => ({ run: vi.fn(), identity: vi.fn(), same: vi.fn(), rename: vi.fn(), unlink: vi.fn() }));
vi.mock("./containAudioRepair", async original => ({ ...await original<typeof import("./containAudioRepair")>(),
  runBoundedAudioAux: mocks.run, containAudioInputIdentity: mocks.identity, sameContainAudioInput: mocks.same }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), rename: mocks.rename, unlink: mocks.unlink }));
const video = () => ({ codec_type: "video", codec_name: "h264", start_time: "0.000000", start_pts: 0,
  time_base: "1/15360", duration: "0.033333", duration_ts: 512, avg_frame_rate: "30/1", r_frame_rate: "30/1" });
const audio = () => ({ codec_type: "audio", codec_name: "aac", profile: "LC", channels: 2, sample_rate: "48000",
  start_time: "0.000000", start_pts: 0, time_base: "1/48000", duration: "0.033333", duration_ts: 1600 });
const format = { format_name: "mov,mp4,m4a,3gp,3g2,mj2", start_time: "0.000000" };
const prefix = (samples: number) => `frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.Number_of_samples=${samples}.000000\n`;
const packets = () => ({ packets: [{ pts: 0, dts: 0, duration: 512, size: "100", data_hash: "SHA256:" + "a".repeat(64) }] });
const params = () => ({ input: "/source", output: "/job/output.mp4", start: 0, end: 1 / 30,
  inputIdentity: { file: "/source", stat: {} as import("node:fs").Stats } });
function results(required = 1600, duration = "0.033333") {
  return [JSON.stringify({ format, streams: [{ ...video(), duration }] }), JSON.stringify({ format, streams: [
    { ...video(), duration: "300.000000", duration_ts: 4608000 },
    { ...audio(), start_time: "1.978000", start_pts: 94944, duration: "300.000000", duration_ts: 14400000 },
  ] }), prefix(required), JSON.stringify(packets()), "", JSON.stringify({ format, streams: [video(), audio()] }),
  JSON.stringify(packets()), prefix(1600)];
}
function responses(rows = results()) { let n = 0; mocks.run.mockImplementation(async () => rows[n++]); }
beforeEach(() => {
  vi.resetAllMocks(); responses(); mocks.identity.mockImplementation(async (file: string) => ({ file, stat: { size: 1000 } }));
  mocks.same.mockResolvedValue(true); mocks.rename.mockResolvedValue(undefined); mocks.unlink.mockResolvedValue(undefined);
});
it("commits only verified video-copy/audio recovery with the existing process budgets", async () => {
  expect(await recoverSelectedSegmentAudio(params())).toBe("repaired");
  expect(mocks.run).toHaveBeenCalledTimes(8);
  const [, args, options] = mocks.run.mock.calls[4];
  expect(args[args.indexOf("-c:v") + 1]).toBe("copy"); expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
  expect(args).not.toContain("-frames:a"); expect(args).not.toContain("apad");
  expect(args[args.indexOf("-fs") + 1]).toBe(String(SELECTED_AUDIO_RECOVERY_LIMITS.outputBytes));
  expect(args[args.indexOf("-movie_timescale") + 1]).toBe("48000");
  expect(options).toEqual({ timeoutMs: 30000, signal: undefined });
  expect(mocks.rename).toHaveBeenCalledWith(args.at(-1), params().output); expect(mocks.unlink).not.toHaveBeenCalled();
});
it("leaves healthy/unknown output unchanged without creating a candidate", async () => {
  mocks.run.mockResolvedValue(JSON.stringify({ format, streams: [video(), audio()] }));
  expect(await recoverSelectedSegmentAudio(params())).toBe("unchanged"); expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(mocks.rename).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
});
it("binds evidence to the original paths and sample range even if caller arguments change", async () => {
  const p = params(), rows = results(); let n = 0;
  mocks.run.mockImplementation(async () => {
    const result = rows[n++];
    if (n === 3) Object.assign(p, { input: "/other-input", output: "/other-output", start: 5 });
    return result;
  });
  expect(await recoverSelectedSegmentAudio(p)).toBe("repaired");
  expect(mocks.rename).toHaveBeenCalledWith(expect.stringMatching(/^\/job\/output\.mp4\./), "/job/output.mp4");
  expect(mocks.run.mock.calls[4][1]).not.toContain("/other-input");
});
it.each(["window", "prefix", "size"])("retains proven-missing status beyond the %s limit", async kind => {
  const p = params();
  if (kind === "window") { p.end = 1.1; responses(results(52800, "1.100000")); }
  if (kind === "prefix") { p.start = 5; p.end = 5.1; responses(results(244800, "0.100000")); }
  if (kind === "size") mocks.identity.mockImplementation(async (file: string) => ({ file, stat: { size: 1048577 } }));
  expect(await recoverSelectedSegmentAudio(p)).toBe("missing"); expect(mocks.run).toHaveBeenCalledTimes(3);
  expect(mocks.rename).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
});
it.each(["video-hash", "video-pts", "video-timebase", "audio-duration", "audio-origin", "audio-count", "candidate-size", "unknown-packets"])("rejects candidate mismatch: %s", async kind => {
  const rows = results(); const result = { format, streams: [video(), audio()] };
  if (kind === "video-hash") { const p = packets(); p.packets[0].data_hash = "SHA256:" + "b".repeat(64); rows[6] = JSON.stringify(p); }
  if (kind === "video-pts") { const p = packets(); p.packets[0].pts++; rows[6] = JSON.stringify(p); }
  if (kind === "video-timebase") result.streams[0].time_base = "1/30000";
  if (kind === "audio-duration") result.streams[1].duration_ts = 1599;
  if (kind === "audio-origin") result.streams[1].start_time = "0.001000";
  if (kind === "audio-count") rows[7] = prefix(1599);
  if (kind === "unknown-packets") rows[6] = JSON.stringify({ packets: [{}] });
  rows[5] = JSON.stringify(result); responses(rows);
  if (kind === "candidate-size") mocks.identity.mockImplementation(async (file: string) => ({ file, stat: { size: file === params().output ? 1000 : 1048577 } }));
  expect(await recoverSelectedSegmentAudio(params())).toBe("missing");
  expect(mocks.rename).not.toHaveBeenCalled(); expect(mocks.unlink).toHaveBeenCalledTimes(1);
});
it.each([3, 4, 5, 6, 7])("requires stable identities through final check %s", async at => {
  let n = 0; mocks.same.mockImplementation(async () => n++ !== at);
  expect(await recoverSelectedSegmentAudio(params())).toBe("missing"); expect(mocks.rename).not.toHaveBeenCalled();
});
it("ordinary encoder failure cleans only its candidate and retains missing status", async () => {
  const rows = results(); let n = 0; mocks.run.mockImplementation(async () => { if (n === 4) throw new Error("encoder failed"); return rows[n++]; });
  expect(await recoverSelectedSegmentAudio(params())).toBe("missing");
  expect(mocks.rename).not.toHaveBeenCalled(); expect(mocks.unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/job\/output\.mp4\..+\.mp4$/));
});
it("abort before work and during candidate verification cannot publish", async () => {
  const before = new AbortController(); before.abort();
  await expect(recoverSelectedSegmentAudio({ ...params(), signal: before.signal })).rejects.toBeInstanceOf(AudioAuxAbort);
  expect(mocks.run).not.toHaveBeenCalled();
  const controller = new AbortController(), rows = results(); let n = 0;
  mocks.run.mockImplementation(async () => { const result = rows[n++]; if (n === 5) controller.abort(); return result; });
  await expect(recoverSelectedSegmentAudio({ ...params(), signal: controller.signal })).rejects.toBeInstanceOf(AudioAuxAbort);
  expect(mocks.rename).not.toHaveBeenCalled(); expect(mocks.unlink).toHaveBeenCalledTimes(1);
  expect(mocks.run.mock.calls.every(call => call[2].signal === controller.signal)).toBe(true);
});
it("process cleanup uncertainty and candidate cleanup failure propagate", async () => {
  const rows = results(); let n = 0; const error = new AudioAuxCleanupError();
  mocks.run.mockImplementation(async () => { if (n === 4) throw error; return rows[n++]; });
  await expect(recoverSelectedSegmentAudio(params())).rejects.toBe(error);
  responses(); mocks.unlink.mockRejectedValue(new Error("candidate cleanup failed"));
  mocks.rename.mockRejectedValue(new Error("rename failed"));
  await expect(recoverSelectedSegmentAudio(params())).rejects.toThrow("candidate cleanup failed");
});
