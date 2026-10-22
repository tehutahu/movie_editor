/** Preview-only, bounded AAC packet-copy normalization. Original files and
 * project source seconds are never rewritten. Unknown diagnostics fall back. */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { containAudioInputIdentity, sameContainAudioInput, runBoundedAudioAux } from "./containAudioRepair";
import { resolveFfmpegPath, resolveFfprobePath, type FfProbeJson } from "./ffmpeg";

const MAX_INPUT = 4 * 1024 * 1024, MAX_AUDIO = 1024 * 1024;
const noSideData = (s: { side_data_list?: unknown }) => s.side_data_list === undefined || Array.isArray(s.side_data_list) && !s.side_data_list.length;
const int = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) ? v : null;

export function negativeMkvAudioFromProbe(raw: FfProbeJson) {
  if (!raw || raw.format?.format_name !== "matroska,webm" || !Array.isArray(raw.streams) || raw.streams.length !== 2 || raw.streams.some(s => !s || typeof s !== "object")) return null;
  const v = raw.streams.find(s => s.codec_type === "video"), a = raw.streams.find(s => s.codec_type === "audio");
  if (!v || !a || v.codec_name !== "h264" || v.start_time !== "0.000000" || v.start_pts !== 0 || v.time_base !== "1/1000" || v.avg_frame_rate !== "30/1" || v.r_frame_rate !== "30/1" ||
      a.codec_name !== "aac" || a.profile !== "LC" || a.sample_rate !== "48000" || ![1, 2].includes(a.channels!) || a.time_base !== "1/1000" || !noSideData(a) ||
      typeof a.start_time !== "string" || !/^-\d{1,2}\.\d{6}$/.test(a.start_time) || a.start_time !== raw.format.start_time) return null;
  if (typeof raw.format.duration !== "string" || !/^\d{1,2}\.\d{6}$/.test(raw.format.duration)) return null;
  const start = int(a.start_pts), duration = Number(raw.format.duration);
  // Ordinary AAC encoder priming (-21ms) is deliberately outside this family.
  if (start === null || start >= -50 || start < -2000 || Number(a.start_time) !== start / 1000 || !Number.isFinite(duration) || duration <= 0 || duration > 5) return null;
  return { start, channels: a.channels, duration };
}

type Packet = { pts?: number; dts?: number; duration?: number; data_hash?: string; side_data_list?: unknown };
/** Millisecond MKV rounding may differ by 1 tick, never gaps/edits/skip hints.
 * Packet count is independently checked against the full decoded byte count. */
export function negativeMkvPackets(raw: unknown, start: number): string[] | null {
  if (!raw || typeof raw !== "object" || !("packets" in raw) || !Array.isArray(raw.packets) || !raw.packets.length || raw.packets.length > 240) return null;
  const hashes: string[] = [];
  for (const [i, p] of (raw.packets as Packet[]).entries()) {
    if (!p || typeof p !== "object" || int(p.pts) === null || i === 0 && p.pts !== start || p.dts !== p.pts || Math.abs(p.pts! - start - i * 1024 / 48) > 1 || p.duration !== 21 || !noSideData(p) ||
        typeof p.data_hash !== "string" || !/^SHA256:[a-f0-9]{64}$/.test(p.data_hash)) return null;
    hashes.push(p.data_hash);
  }
  return hashes;
}

export function normalizedMkvPackets(raw: unknown, hashes: string[]): boolean {
  if (!hashes.length || !raw || typeof raw !== "object" || !("packets" in raw) || !Array.isArray(raw.packets) || raw.packets.length !== hashes.length) return false;
  return (raw.packets as Packet[]).every((p, i) => p && p.pts === i * 1024 && p.dts === p.pts && p.duration === 1024 && p.data_hash === hashes[i] && noSideData(p));
}

const aux = (command: string, args: string[]) => runBoundedAudioAux(command, args, { timeoutMs: 5000 });
const probe = async (file: string): Promise<FfProbeJson> => JSON.parse(await aux(resolveFfprobePath(), ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
const packets = async (file: string): Promise<unknown> => JSON.parse(await aux(resolveFfprobePath(), ["-v", "error", "-select_streams", "a:0", "-show_packets", "-show_entries", "packet=pts,dts,duration,data_hash,side_data_list", "-show_data_hash", "sha256", "-of", "json", file]));
async function decodedHash(file: string) {
  // streamhash has no sample count. framehash provides byte count AND payload
  // hashes, independent of packet/container timing, without buffering PCM.
  return aux(resolveFfmpegPath(), ["-v", "error", "-xerror", "-i", file, "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", "-f", "framemd5", "-hash", "sha256", "-"]);
}
export function decodedMkvFrames(text: string, count: number): string | null {
  const rows = text.split(/\r?\n/).filter(line => line && !line.startsWith("#"));
  if (rows.length !== count) return null;
  const hashes: string[] = [];
  for (const row of rows) {
    const m = /^0,\s*-?\d+,\s*-?\d+,\s*1024,\s*8192,\s*([a-f0-9]{64})$/.exec(row);
    if (!m) return null;
    hashes.push(m[1]);
  }
  return hashes.join(":");
}

/** At most 2 active candidates, 8 cached identities / 8MiB. Cache is runtime
 * only; no persistent derivative, project field, external service or URL. */
const cache = new Map<string, Buffer | null>();
const pending = new Map<string, Promise<Buffer | null>>();
export async function negativeMkvPreviewAudio(file: string): Promise<Buffer | null> {
  if (path.extname(file).toLowerCase() !== ".mkv") return null;
  const identity = await containAudioInputIdentity(file);
  if (!identity || identity.stat.size > MAX_INPUT) return null;
  const s = identity.stat, key = JSON.stringify([file, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
  if (cache.has(key)) return cache.get(key)!;
  if (pending.has(key)) return pending.get(key)!;
  if (pending.size >= 2) return null;
  const work = (async () => {
    let dir: string | undefined;
    try {
      const clock = negativeMkvAudioFromProbe(await probe(file));
      if (!clock) return null;
      const hashes = negativeMkvPackets(await packets(file), clock.start);
      if (!hashes) return null;
      const original = decodedMkvFrames(await decodedHash(file), hashes.length);
      if (!original || !await sameContainAudioInput(identity)) return null;
      dir = await mkdtemp(path.join(tmpdir(), "movie-editor-preview-audio-"));
      const candidate = path.join(dir, "audio.m4a");
      // Match the movie clock too: probe4 otherwise rounds the exact 97280
      // sample track to a millisecond movie duration (97296 samples).
      await aux(resolveFfmpegPath(), ["-v", "error", "-xerror", "-i", file, "-map", "0:a:0", "-vn", "-c:a", "copy", "-bsf:a", "setts=time_base=1/48000:pts=N*1024:dts=N*1024:duration=1024", "-fs", String(MAX_AUDIO), "-movie_timescale", "48000", "-movflags", "+faststart", candidate]);
      if ((await stat(candidate)).size > MAX_AUDIO) return null;
      const result = await probe(candidate), a = result.streams?.[0];
      // A short audio track would make play() beyond its EOF restart at zero.
      // Keep the original unless canonical audio covers the legal container
      // source range with at least one original millisecond tick to spare.
      if (hashes.length * 1024 / 48000 < clock.duration + .001 || result.streams?.length !== 1 || !a || a.codec_type !== "audio" || a.codec_name !== "aac" || a.profile !== "LC" || a.sample_rate !== "48000" || a.channels !== clock.channels || a.start_pts !== 0 || a.start_time !== "0.000000" || a.time_base !== "1/48000" || a.duration_ts !== hashes.length * 1024 || !noSideData(a) ||
          !normalizedMkvPackets(await packets(candidate), hashes) || decodedMkvFrames(await decodedHash(candidate), hashes.length) !== original || !await sameContainAudioInput(identity)) return null;
      const bytes = await readFile(candidate);
      return await sameContainAudioInput(identity) ? bytes : null;
    } catch { return null; }
    finally { if (dir) await rm(dir, { recursive: true, force: true }); }
  })();
  pending.set(key, work);
  try {
    const result = await work;
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
  } finally { pending.delete(key); }
}

