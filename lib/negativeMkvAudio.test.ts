import { expect, it } from "vitest";
import { decodedMkvFrames, negativeMkvAudioFromProbe, negativeMkvPackets, normalizedMkvPackets } from "./negativeMkvAudio";
import type { FfProbeJson } from "./ffmpeg";
const probe = (): FfProbeJson => ({ format: { format_name: "matroska,webm", start_time: "-0.221000", duration: "1.967000" }, streams: [
  { codec_type: "video", codec_name: "h264", time_base: "1/1000", start_pts: 0, start_time: "0.000000", avg_frame_rate: "30/1", r_frame_rate: "30/1" },
  { codec_type: "audio", codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 1, time_base: "1/1000", start_pts: -221, start_time: "-0.221000" },
] });
const hash = `SHA256:${"a".repeat(64)}`;
it("recognizes only the measured negative AAC/MKV family", () => { expect(negativeMkvAudioFromProbe(probe())).toEqual({ start: -221, channels: 1, duration: 1.967 }); });
it.each([null, {}, { streams: [null] }])("rejects unknown diagnostics %j", raw => { expect(negativeMkvAudioFromProbe(raw as FfProbeJson)).toBeNull(); });
it.each([
  { codec_name: "opus" }, { profile: "HE-AAC" }, { sample_rate: "44100" }, { channels: 6 }, { time_base: "1/48000" },
  { start_pts: -21, start_time: "-0.021000" }, { start_pts: -220 }, { start_pts: "-221" }, { start_time: "-0.221" }, { side_data_list: [ { side_data_type: "Skip Samples" } ] },
])("preserves unknown or normal audio %j", change => { const p = probe(); Object.assign(p.streams![1], change); expect(negativeMkvAudioFromProbe(p)).toBeNull(); });
it.each(["0", "NaN", "6", undefined])("requires bounded actual container duration %s", duration => { const p = probe(); p.format!.duration = duration; expect(negativeMkvAudioFromProbe(p)).toBeNull(); });
it("packet timestamps must match the measured ms grid without gaps or skip edits", () => {
  const p = { packets: [0, 1, 2].map(i => ({ pts: -221 + Math.round(i * 1024 / 48), dts: -221 + Math.round(i * 1024 / 48), duration: 21, data_hash: hash })) };
  expect(negativeMkvPackets(p, -221)).toEqual([hash, hash, hash]);
  p.packets[1].pts += 2; p.packets[1].dts += 2; expect(negativeMkvPackets(p, -221)).toBeNull();
});
it("normalized packets preserve ordered payloads and exact final duration", () => {
  const p = { packets: [{ pts: 0, dts: 0, duration: 1024, data_hash: hash }] };
  expect(normalizedMkvPackets(p, [hash])).toBe(true); p.packets[0].duration = 1000; expect(normalizedMkvPackets(p, [hash])).toBe(false);
});
it("full decoded proof checks sample count, channel bytes and every frame hash", () => {
  const row = `0, -10608, -10608, 1024, 8192, ${"a".repeat(64)}\n`;
  expect(decodedMkvFrames(`# header\n${row}`, 1)).toBe("a".repeat(64));
  expect(decodedMkvFrames(row, 2)).toBeNull(); expect(decodedMkvFrames(row.replace("8192", "4096"), 1)).toBeNull();
});
