/** Runtime diagnostics only. Saved source seconds refer to each stream's own
 * first timestamp, as in contain; they never include the container's AV gap. */
import { rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { containAudioInputIdentity, containAudioSeekFromProbe, sameContainAudioInput,
  runBoundedAudioAux, CONTAIN_AUDIO_AUX_BUDGET, AudioAuxAbort, AudioAuxCleanupError,
  verifiedClockDuration, verifiedClockRangeCovered } from "./containAudioRepair";
import { extractSegmentTimes, resolveFfmpegPath, resolveFfprobePath, type FfProbeJson } from "./ffmpeg";

export function sourceAvClockFromProbe(raw: FfProbeJson) {
  const audio = containAudioSeekFromProbe(raw);
  if (!audio) return null;
  const v = raw.streams!.find(s => s.codec_type === "video")!;
  const origin = Number(v.start_time), videoDuration = verifiedClockDuration(v);
  if (!videoDuration) return null;
  // Decode/normalize fallback is deliberately limited to the measured CFR30
  // family. Preview's offset does not resample media and needs no rate gate.
  return { videoOrigin: origin, videoDuration, audioDuration: audio.audioDuration,
    videoStartPts: String(v.start_pts), videoTimeBase: v.time_base!,
    repairable: v.avg_frame_rate === "30/1" && v.r_frame_rate === "30/1" };
}
async function boundedProbe(file: string, signal?: AbortSignal): Promise<FfProbeJson> {
  return JSON.parse(await runBoundedAudioAux(resolveFfprobePath(),
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.probeMs, signal }));
}
export async function inspectSourceAvClock(input: string, signal?: AbortSignal) {
  try {
    if (signal?.aborted) throw new AudioAuxAbort();
    const identity = await containAudioInputIdentity(input);
    if (signal?.aborted) throw new AudioAuxAbort();
    if (!identity) return null;
    const clock = sourceAvClockFromProbe(await boundedProbe(input, signal));
    const stable = clock && await sameContainAudioInput(identity);
    if (signal?.aborted) throw new AudioAuxAbort();
    return stable ? { ...clock, identity } : null;
  } catch (error) {
    if (signal?.aborted || error instanceof AudioAuxAbort || error instanceof AudioAuxCleanupError) throw error;
    return null;
  }
}
/** A complete legacy output keeps its exact bytes, even for eligible inputs.
 * Tolerance allows the existing frame grid and AAC end padding, not a new cut. */
export function incompleteSourceAvSegment(raw: FfProbeJson, duration: number): boolean | null {
  if (!Array.isArray(raw.streams) || raw.streams.some(s => !s || typeof s !== "object" ||
      typeof s.codec_type !== "string" || !["video", "audio", "subtitle", "data", "attachment"].includes(s.codec_type))) return null;
  let unknown = false;
  for (const kind of ["video", "audio"]) {
    const s = raw.streams?.find(s => s.codec_type === kind);
    if (!s) return true;
    const start = Number(s.start_time), length = Number(s.duration);
    if (typeof s.start_time !== "string" || typeof s.duration !== "string" ||
        !Number.isFinite(start) || start < 0 || !Number.isFinite(length) || length <= 0) unknown = true;
    else if (start > 1 / 30 || length < duration - 1 / 30) return true;
  }
  return unknown ? null : false;
}
const num = (n: number) => String(Number(n.toFixed(9)));
/** Same positive decimal -> microsecond truncation -> nearest 48k sample as
 * ffmpeg's output seek. Integer arithmetic avoids binary boundary drift. */
export function sourceAudioSample(start: number): number {
  const [whole, fraction = ""] = num(start).split(".");
  const micros = BigInt(whole) * BigInt(1_000_000) + BigInt((fraction + "000000").slice(0, 6));
  return Number((micros * BigInt(48000) + BigInt(500000)) / BigInt(1_000_000));
}
/** Old bundled probes can include a positive origin in stream.duration.
 * Prove a complete contiguous CFR30 packet grid before trusting EOF coverage.
 * Full packet diagnostics retain the same 5s/1MiB auxiliary limits. */
export function verifiedVideoPacketDuration(raw: { packets?: { pts?: number | string; duration?: number | string }[] }, startPts: string, timeBase: string) {
  if (!raw || !Array.isArray(raw.packets) || !raw.packets.length) return null;
  const tb = /^(\d{1,20})\/(\d{1,20})$/.exec(timeBase);
  if (!tb || !/^-?\d{1,40}$/.test(startPts)) return null;
  const numerator = BigInt(tb[1]) * BigInt(30), denominator = BigInt(tb[2]);
  if (!numerator || !denominator || denominator % numerator !== BigInt(0)) return null;
  const step = denominator / numerator;
  const integer = (x: unknown) => typeof x === "number" ? Number.isSafeInteger(x) : typeof x === "string" && /^-?\d{1,40}$/.test(x);
  if (raw.packets.some(p => !p || !integer(p.pts) || !integer(p.duration) || BigInt(p.duration!) !== step)) return null;
  const pts = raw.packets.map(p => BigInt(p.pts!)).sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
  if (pts.some((p,i) => p !== BigInt(startPts) + BigInt(i) * step)) return null;
  return { n: BigInt(pts.length), d: BigInt(30) };
}

/** Called only after successful legacy extraction, never hides its failure.
 * Owns one unique candidate; unknown metadata/timeout/failure leave old bytes.
 * No candidate is accepted without stream coverage and stable input identity. */
export async function repairSourceAvSegment(params: { input: string; output: string; start: number; end: number;
  size?: { width: number; height: number }; signal?: AbortSignal }) {
  const { input, output, start, end, size, signal } = params;
  if (signal?.aborted) throw new AudioAuxAbort();
  const duration = end - start;
  if (!(Number.isFinite(start) && start >= 0 && Number.isFinite(duration) && duration >= 1 / 30)) return false;
  const clock = await inspectSourceAvClock(input, signal);
  if (signal?.aborted) throw new AudioAuxAbort();
  if (!clock?.repairable || ![clock.audioDuration, clock.videoDuration].every(limit =>
    verifiedClockRangeCovered(limit, num(start), num(duration)))) return false;
  let candidate: string | undefined;
  try {
    const old = await boundedProbe(output, signal);
    if (signal?.aborted) throw new AudioAuxAbort();
    if (incompleteSourceAvSegment(old, duration) !== true) return false;
    const packets = JSON.parse(await runBoundedAudioAux(resolveFfprobePath(),
      ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts,duration", "-of", "json", input],
      { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.probeMs, signal }));
    const videoDuration = verifiedVideoPacketDuration(packets, clock.videoStartPts, clock.videoTimeBase);
    if (signal?.aborted) throw new AudioAuxAbort();
    if (!videoDuration || !verifiedClockRangeCovered(videoDuration, num(start), num(duration))) return false;
    if (!await sameContainAudioInput(clock.identity)) return false;
    candidate = `${output}.${randomUUID()}.mp4`;
    const frames = Math.ceil(duration * 30);
    // Match contain's hold-previous CFR sampling, including an exclusive end.
    // Audio decodes from its own zero and is trimmed independently of video.
    const video = `trim=end=${num(clock.videoOrigin + end)},setpts=PTS-${num(clock.videoOrigin + start)}/TB,fps=30:start_time=0:round=up,tpad=stop_mode=clone:stop_duration=${num((frames + 1) / 30)},trim=end_frame=${frames},setpts=N/(30*TB)${size ? `,scale=${size.width}:${size.height},setsar=1,format=yuv420p` : ""}`;
    const audio = `aresample=48000,atrim=start_sample=${sourceAudioSample(start)}:end_sample=${sourceAudioSample(start) + sourceAudioSample(duration)},asetpts=PTS-STARTPTS,apad`;
    await runBoundedAudioAux(resolveFfmpegPath(), ["-y", "-copyts", "-noaccurate_seek", "-ss", num(start), "-i", input,
      "-i", input, "-filter_complex", `[0:v:0]${video}[v];[1:a:0]${audio}[a]`,
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-r", "30", "-enc_time_base:v", "1:30", "-fps_mode:v", "cfr",
      "-c:a", "aac", "-ac", "2", "-ar", "48000",
      "-t", num(duration), "-movflags", "+faststart", candidate], { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.retryMs, signal });
    const result = await boundedProbe(candidate, signal);
    const stable = await sameContainAudioInput(clock.identity);
    if (signal?.aborted) throw new AudioAuxAbort();
    if (incompleteSourceAvSegment(result, duration) !== false || !stable || result.streams!.length !== 2 ||
      result.streams!.some(s => Number(s.duration) > duration + 1 / 30)) return false;
    // Atomic rename is the commit point. Cancellation before this point keeps
    // old bytes; cancellation after publication cannot roll them back.
    await rename(candidate, output);
    candidate = undefined;
    return true;
  } catch (error) {
    if (signal?.aborted || error instanceof AudioAuxAbort || error instanceof AudioAuxCleanupError) throw error;
    return false;
  } finally {
    if (candidate) await unlink(candidate).catch(e => { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; });
  }
}
/** NLE selected/stretch entry point. Shared legacy extraction stays unchanged. */
export async function extractEditorSegment(params: Parameters<typeof extractSegmentTimes>[0]) {
  await extractSegmentTimes(params);
  await repairSourceAvSegment({ input: params.inputPath, output: params.outputPath, start: params.startSec, end: params.endSec });
  // ffmpeg can exit zero with an empty MP4. Never publish it as a successful
  // selected download (unknown timing remains an explicit failure).
  let output: FfProbeJson;
  try { output = await boundedProbe(params.outputPath); }
  catch (error) {
    if (error instanceof AudioAuxCleanupError) throw error;
    return; // failed optional diagnosis cannot turn a legacy success into error
  }
  if (output && Array.isArray(output.streams) && output.streams.every(s => s && typeof s.codec_type === "string") &&
      !output.streams.some(s => s.codec_type === "video")) {
    await unlink(params.outputPath);
    throw new Error("素材区間から映像を取り出せません。対応する映像時計を確認できませんでした。");
  }
}
