import { expect, it, vi } from "vitest";
import { inputAudioFromProbe } from "./restoreInputAudio";
import { parseInputAudio, restoreInputTarget } from "./editor/restoreInputAudio";
import { createEmptyProject } from "./editor/project";
vi.mock("./ffmpeg", () => ({ probeMedia: vi.fn() }));
it("observes a:0 rather than the default audio stream", () => {
  const probe = { streams: [{ codec_type: "video", index: 0 }, { codec_type: "audio", index: 1, sample_rate: "44100", disposition: { default: 0 } }, { codec_type: "audio", index: 2, sample_rate: "48000", disposition: { default: 1 } }] };
  expect(inputAudioFromProbe(probe)).toEqual({ status: "known", streamOrdinal: 0, streamIndex: 1, sampleRateHz: 44100 });
  expect(inputAudioFromProbe({ streams: [...probe.streams].reverse() })).toEqual({ status: "known", streamOrdinal: 0, streamIndex: 2, sampleRateHz: 48000 });
});
it("distinguishes no audio and unknown without falling back to 44100", () => {
  expect(inputAudioFromProbe({ streams: [{ codec_type: "video" }] })).toEqual({ status: "none" });
  for (const sample_rate of [undefined, "", "0", "NaN", "48000.5", "-1", "1e5", "9007199254740992"]) {
    expect(inputAudioFromProbe({ streams: [{ codec_type: "audio", index: 3, sample_rate }] })).toEqual({ status: "unknown", streamOrdinal: 0, streamIndex: 3 });
  }
  expect(inputAudioFromProbe({ streams: [{ codec_type: "audio", sample_rate: "48000" }] })).toEqual({ status: "unknown", streamOrdinal: 0 });
});
it.each([32000, 44100, 48000, 96000])("preserves rate %s in the untrusted client response", rate => {
  const audio = inputAudioFromProbe({ streams: [{ codec_type: "audio", index: 4, sample_rate: String(rate) }] });
  expect(parseInputAudio(audio)).toEqual({ status: "known", streamOrdinal: 0, streamIndex: 4, sampleRateHz: rate });
});
it("rejects malformed known metadata and preserves none/unknown", () => {
  for (const bad of [null, [], { status: "known", streamOrdinal: 1, streamIndex: 0, sampleRateHz: 48000 }, { status: "known", streamOrdinal: 0, streamIndex: 0, sampleRateHz: "48000" }, { status: "known", streamOrdinal: 0, sampleRateHz: 44100 }, { status: "unknown", streamOrdinal: 0, streamIndex: -1 }, { status: "other" }]) expect(() => parseInputAudio(bad)).toThrow();
  expect(parseInputAudio({ status: "none" })).toEqual({ status: "none" });
  expect(parseInputAudio({ status: "unknown", streamOrdinal: 0 })).toEqual({ status: "unknown", streamOrdinal: 0 });
});
it("targets current selected[0]/parts[0] with physical source and epoch identity", () => {
  const p = createEmptyProject(); p.assets = [{ id: "a", storageAssetId: "physical", sourceJobId: "restored", kind: "video", ext: "mp4", displayName: "current", streamUrl: "/restored" }];
  p.clips = [{ id: "clip", trackId: p.tracks[0].id, timelineStartSec: 0, durationSec: 2, parts: [{ assetId: "a", sourceInSec: 1, sourceOutSec: 2 }, { assetId: "b", sourceInSec: 0, sourceOutSec: 1 }], transform: { x: .5, y: .5, scale: 1 } }];
  p.selectedClipIds = ["clip", "other"];
  const before = structuredClone(p), target = restoreInputTarget(p, 1)!;
  expect(target.source).toEqual({ assetId: "a", storageAssetId: "physical", sourceJobId: "restored", streamUrl: "/restored" });
  expect(restoreInputTarget({ ...p, playheadSec: 1 }, 1)?.key).toBe(target.key);
  expect(restoreInputTarget(p, 2)?.key).not.toBe(target.key);
  expect(restoreInputTarget({ ...p, assets: [{ ...p.assets[0], sourceJobId: "new" }] }, 1)?.key).not.toBe(target.key);
  expect(restoreInputTarget({ ...p, selectedClipIds: ["other", "clip"] }, 1)).toBe(null);
  expect(p).toEqual(before);
});
