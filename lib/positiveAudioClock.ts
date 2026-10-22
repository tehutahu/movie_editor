import type { FfProbeJson } from "./ffmpeg";
import { verifiedClockDuration } from "./containAudioRepair";

const integer = (value: unknown): bigint | null => typeof value === "number"
  ? Number.isSafeInteger(value) ? BigInt(value) : null
  : typeof value === "string" && /^-?\d{1,20}$/.test(value) ? BigInt(value) : null;

/** A separate export-only family. Do not broaden contain/native preview clocks.
 * Packet span AND actual decoded prefix coverage are still mandatory. */
export function positiveAudioClockFromProbe(raw: FfProbeJson) {
  if (!raw || raw.format?.format_name !== "mov,mp4,m4a,3gp,3g2,mj2" || raw.format.start_time !== "0.000000" ||
      !Array.isArray(raw.streams) || raw.streams.length !== 2 || raw.streams.some(s=>!s||typeof s!=="object")) return null;
  const v = raw.streams.find(s => s.codec_type === "video"), a = raw.streams.find(s => s.codec_type === "audio");
  if (!v || !a || v.codec_name !== "h264" || v.start_time !== "0.000000" || integer(v.start_pts) !== BigInt(0) ||
      v.avg_frame_rate !== "30/1" || v.r_frame_rate !== "30/1" || a.codec_name !== "aac" || a.profile !== "LC" ||
      a.sample_rate !== "48000" || ![1, 2].includes(a.channels!) || a.time_base !== "1/48000" ||
      a.side_data_list !== undefined && (!Array.isArray(a.side_data_list) || a.side_data_list.length !== 0) ||
      typeof a.start_time !== "string" || !/^\d{1,10}\.\d{6}$/.test(a.start_time)) return null;
  const pts = integer(a.start_pts), duration = verifiedClockDuration(a);
  const [whole, fraction] = a.start_time.split(".");
  const micros = BigInt(whole) * BigInt(1_000_000) + BigInt(fraction);
  if (pts === null || pts <= BigInt(0) || micros <= BigInt(0) || !duration) return null;
  const delta = pts * BigInt(1_000_000) - micros * BigInt(48000);
  if (delta < BigInt(-1_000_000) || delta > BigInt(1_000_000)) return null;
  return { audioDuration: duration, audioStartPts: String(pts) };
}

/** AAC access units: no edits/skip hints, gaps or non-final partial packets.
 * Old probes overreport positive-origin duration, so measure real packet EOF. */
export function verifiedPositiveAudioPacketDuration(raw: unknown, startPts: string) {
  if (!raw || typeof raw !== "object" || !("packets" in raw) || !Array.isArray(raw.packets) || !raw.packets.length || !/^\d{1,20}$/.test(startPts)) return null;
  const start = BigInt(startPts); let next = start;
  for (let i=0; i<raw.packets.length; i++) {
    const p: unknown = raw.packets[i];
    if (!p || typeof p !== "object" || !("pts" in p) || !("duration" in p)) return null;
    const pts = integer(p.pts), duration = integer(p.duration);
    if (pts !== next || duration === null || duration <= BigInt(0) || duration > BigInt(1024) ||
        i < raw.packets.length-1 && duration !== BigInt(1024) ||
        "side_data_list" in p && (!Array.isArray(p.side_data_list) || p.side_data_list.length !== 0)) return null;
    next += duration;
  }
  return { n: next-start, d: BigInt(48000) };
}

/** astats observes actual 48k decoded samples before any apad. Strictly parse
 * our own bounded metadata output; malformed/short/unknown is a fallback. */
export function verifiedDecodedAudioPrefix(text: string, required: number) {
  if (!Number.isSafeInteger(required) || required <= 0) return false;
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length || lines.length % 2) return false;
  let previous = BigInt(0);
  for (let i=0; i<lines.length; i+=2) {
    if (!new RegExp(`^frame:${i/2}\\s+pts:-?\\d+\\s+pts_time:[-+\\d.e]+$`).test(lines[i])) return false;
    const m = /^lavfi\.astats\.Overall\.Number_of_samples=(\d{1,15})\.000000$/.exec(lines[i+1]);
    if (!m) return false;
    const count = BigInt(m[1]);
    if (count <= previous || count > BigInt(required)) return false;
    previous = count;
  }
  return previous === BigInt(required);
}
