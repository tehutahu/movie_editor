import { beforeEach, expect, it, vi } from "vitest";
import { AudioAuxAbort, AudioAuxCleanupError, CONTAIN_AUDIO_AUX_BUDGET } from "./containAudioRepair";
import { continuousSelectedAudioPrefix, hasProvenSelectedAudioLoss } from "./selectedSegmentAudio";
import type { FfProbeJson } from "./ffmpeg";

const mocks = vi.hoisted(() => ({ run: vi.fn(), identity: vi.fn(), same: vi.fn() }));
vi.mock("./containAudioRepair", async original => ({
  ...await original<typeof import("./containAudioRepair")>(),
  runBoundedAudioAux: mocks.run, containAudioInputIdentity: mocks.identity, sameContainAudioInput: mocks.same,
}));
const source = (): FfProbeJson => ({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", start_time: "0.000000" }, streams: [
  { codec_type: "video", codec_name: "h264", start_time: "0.000000", start_pts: 0, time_base: "1/15360",
    duration: "300.000000", duration_ts: 4608000, avg_frame_rate: "30/1", r_frame_rate: "30/1" },
  { codec_type: "audio", codec_name: "aac", profile: "LC", channels: 1, sample_rate: "48000",
    start_time: "1.978000", start_pts: 94944, time_base: "1/48000", duration: "300.000000", duration_ts: 14400000 },
] });
const output = (): FfProbeJson => ({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" }, streams: [
  { codec_type: "video", codec_name: "h264", start_time: "0.000000", duration: "0.600000" },
] });
const prefix = "frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.Number_of_samples=1024.000000\nframe:1 pts:1024 pts_time:0.0213333\nlavfi.astats.Overall.Number_of_samples=1600.000000\n";
const params = () => ({ input: "/input", output: "/output", start: 0, end: 1 / 30,
  inputIdentity: { file: "/input", stat: {} as import("node:fs").Stats } });
function responses(out = output(), input = source(), text = prefix) {
  mocks.run.mockResolvedValueOnce(JSON.stringify(out)).mockResolvedValueOnce(JSON.stringify(input)).mockResolvedValueOnce(text);
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.identity.mockImplementation(async (file: string) => ({ file, stat: {} })); mocks.same.mockResolvedValue(true);
});

it("requires sample coverage and exact continuous PTS, including the first frame", () => {
  expect(continuousSelectedAudioPrefix(prefix, 1600)).toBe(true);
  for (const text of [prefix.replace("pts:1024", "pts:49024"), prefix.replace("pts:0", "pts:1"),
    prefix.replace("pts:1024", "pts:0"), prefix.replace("1600.000000", "1599.000000"), prefix + "unknown\n", ""]) {
    expect(continuousSelectedAudioPrefix(text, 1600)).toBe(false);
  }
});

it("proves missing audio with bounded prefix diagnostics and pre-extraction identity", async () => {
  const out = output(); out.streams![0].duration = "0.033333"; responses(out);
  expect(await hasProvenSelectedAudioLoss(params())).toBe(true);
  expect(mocks.run).toHaveBeenCalledTimes(3);
  const [, args, options] = mocks.run.mock.calls[2];
  expect(args).toContain("-xerror"); expect(args).toContain("-frames:a");
  expect(args[args.indexOf("-frames:a") + 1]).toBe("2");
  expect(args[args.indexOf("-af") + 1]).toContain("atrim=end_sample=1600");
  expect(args[args.indexOf("-af") + 1]).not.toMatch(/apad|async=/);
  expect(options).toEqual({ timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.probeMs });
  expect(mocks.same).toHaveBeenCalledTimes(3);
});

it.each([
  {}, { streams: null }, { streams: [null] }, { streams: [{ codec_type: "unknown" }] },
  { streams: [{ codec_type: "video" }, { codec_type: "audio" }] },
  { format: { format_name: "matroska,webm" }, streams: output().streams },
])("keeps healthy or unknown output untouched: %j", async raw => {
  mocks.run.mockResolvedValueOnce(JSON.stringify(raw));
  expect(await hasProvenSelectedAudioLoss(params())).toBe(false); expect(mocks.run).toHaveBeenCalledTimes(1);
});
it.each([{ start_time: "N/A" }, { duration: "NaN" }, { start_time: "0.100000" },
  { duration: "0.000000" }, { duration: "3.000000" }, { codec_name: "vp9" }])("keeps unverified video %j", async patch => {
  const out = output(); Object.assign(out.streams![0], patch); responses(out);
  expect(await hasProvenSelectedAudioLoss({ ...params(), end: .6 })).toBe(false);
});
it.each(["zero-origin", "noaudio", "shortaudio", "shortvideo", "other-rate"])("keeps input outside proof: %s", async kind => {
  const s = source();
  if (kind === "zero-origin") Object.assign(s.streams![1], { start_time: "0.000000", start_pts: 0 });
  if (kind === "noaudio") s.streams!.pop();
  if (kind === "shortaudio") Object.assign(s.streams![1], { duration: "0.010000", duration_ts: 480 });
  if (kind === "shortvideo") Object.assign(s.streams![0], { duration: "0.010000", duration_ts: 154 });
  if (kind === "other-rate") s.streams![0].avg_frame_rate = "25/1";
  responses(output(), s);
  expect(await hasProvenSelectedAudioLoss({ ...params(), end: .6 })).toBe(false);
});
it.each(["gap", "short", "limit", "bad-json"])("keeps inconclusive diagnostics: %s", async kind => {
  const out = output(); out.streams![0].duration = "0.033333";
  if (kind === "bad-json") mocks.run.mockResolvedValueOnce("invalid");
  else {
    mocks.run.mockResolvedValueOnce(JSON.stringify(out)).mockResolvedValueOnce(JSON.stringify(source()));
    if (kind === "limit") mocks.run.mockRejectedValueOnce(new Error("Audio auxiliary output limit"));
    else mocks.run.mockResolvedValueOnce(kind === "gap" ? prefix.replace("pts:1024", "pts:49024") : prefix.replace("1600.000000", "1599.000000"));
  }
  expect(await hasProvenSelectedAudioLoss(params())).toBe(false);
});
it.each([0, 1, 2])("rejects changed input/output identity at check %s", async index => {
  const out = output(); out.streams![0].duration = "0.033333"; responses(out);
  let n = 0; mocks.same.mockImplementation(async () => n++ !== index);
  expect(await hasProvenSelectedAudioLoss(params())).toBe(false);
});
it("requires the matching pre-extraction identity and an existing owned output", async () => {
  expect(await hasProvenSelectedAudioLoss({ ...params(), inputIdentity: undefined })).toBe(false);
  expect(await hasProvenSelectedAudioLoss({ ...params(), input: "/different" })).toBe(false);
  mocks.identity.mockResolvedValue(undefined);
  expect(await hasProvenSelectedAudioLoss(params())).toBe(false); expect(mocks.run).not.toHaveBeenCalled();
});
it.each([new AudioAuxAbort(), new AudioAuxCleanupError()])("propagates process cleanup/abort uncertainty", async error => {
  mocks.run.mockRejectedValueOnce(error);
  await expect(hasProvenSelectedAudioLoss(params())).rejects.toBe(error);
});
it.each([{ start: -1, end: .6 }, { start: 0, end: .001 }, { start: NaN, end: .6 },
  { start: 1e30, end: 2e30 }])("keeps invalid/unrepresentable ranges %j", async range => {
  expect(await hasProvenSelectedAudioLoss({ ...params(), ...range })).toBe(false);
});
