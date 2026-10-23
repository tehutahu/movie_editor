/** Selected-source downloads retain the source audio, including silent tracks.
 * Diagnosis and bounded early-window recovery apply to one known family only,
 * on selected downloads or source parts before composition gain/track choice.
 * Never diagnose final composition renders, where muting may drop audio. */
import { randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { resolveFfmpegPath, resolveFfprobePath, type FfProbeJson } from "./ffmpeg";
import { AudioAuxAbort, AudioAuxCleanupError, CONTAIN_AUDIO_AUX_BUDGET,
  containAudioInputIdentity, sameContainAudioInput, runBoundedAudioAux,
  verifiedClockDuration, verifiedClockRangeCovered } from "./containAudioRepair";
import { positiveAudioClockFromProbe, verifiedDecodedAudioPrefix } from "./positiveAudioClock";
import { sourceAudioSample } from "./sourceAvClock";

/** Sample counts alone cannot prove coverage: a decoded prefix can cross a
 * timestamp gap while accumulating enough samples. The filter uses 1/48000. */
export function continuousSelectedAudioPrefix(text: string, required: number) {
  if (!verifiedDecodedAudioPrefix(text, required)) return false;
  const lines = text.trim().split(/\r?\n/);
  let previous = BigInt(0);
  for (let i = 0; i < lines.length; i += 2) {
    const pts = /^frame:\d+\s+pts:(-?\d+)\s/.exec(lines[i]);
    if (!pts || BigInt(pts[1]) !== previous) return false;
    previous = BigInt(lines[i + 1].split("=")[1].split(".")[0]);
  }
  return true;
}

const num = (value: number) => String(Number(value.toFixed(9)));
async function probe(file: string, signal?: AbortSignal) {
  return JSON.parse(await runBoundedAudioAux(resolveFfprobePath(),
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.probeMs, signal })) as FfProbeJson;
}

/** True only when known metadata AND actual continuous decoded samples prove
 * source audio exists throughout this selection but the final output lacks it.
 * Unknown, short, discontinuous or over-budget diagnostics preserve old output.
 * Caller owns publication/deletion and must check its job output path first. */
export type SelectedAudioLossParams = {
  input: string; output: string; start: number; end: number;
  /** Must be captured by the selected API before legacy extraction starts. */
  inputIdentity: Awaited<ReturnType<typeof containAudioInputIdentity>>;
  signal?: AbortSignal;
};
type LossEvidence = { outputIdentity: NonNullable<SelectedAudioLossParams["inputIdentity"]>;
  result: FfProbeJson; required: number; duration: number };
async function inspectSelectedAudioLoss(params: SelectedAudioLossParams): Promise<LossEvidence | null> {
  const { input, output, start, end, inputIdentity: identity, signal } = params, duration = end - start;
  if (signal?.aborted) throw new AudioAuxAbort();
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < 1 / 30) return null;
  try {
    if (!identity || identity.file !== input || !await sameContainAudioInput(identity)) return null;
    const required = sourceAudioSample(start) + sourceAudioSample(duration);
    if (!Number.isSafeInteger(required) || required <= 0) return null;
    const outputIdentity = await containAudioInputIdentity(output);
    if (!outputIdentity) return null;
    const result = await probe(output, signal);
    if (!result || result.format?.format_name !== "mov,mp4,m4a,3gp,3g2,mj2" ||
        !Array.isArray(result.streams) || result.streams.length !== 1) return null;
    const video = result.streams[0];
    if (!video || video.codec_type !== "video" || video.codec_name !== "h264" ||
        typeof video.start_time !== "string" || !/^\d{1,10}\.\d{6}$/.test(video.start_time) ||
        typeof video.duration !== "string" || !/^\d{1,10}\.\d{6}$/.test(video.duration)) return null;
    const outputStart = Number(video.start_time), outputDuration = Number(video.duration);
    if (!Number.isFinite(outputStart) || outputStart < 0 || outputStart > 1 / 30 ||
        !Number.isFinite(outputDuration) || outputDuration <= 0 || outputDuration < duration - 1 / 30 || outputDuration > duration + 1 / 30) return null;
    const source = await probe(input, signal), clock = positiveAudioClockFromProbe(source);
    if (!clock) return null;
    const videoDuration = verifiedClockDuration(source.streams!.find(s => s.codec_type === "video")!);
    if (!videoDuration || ![videoDuration, clock.audioDuration].every(limit =>
      verifiedClockRangeCovered(limit, num(start), num(duration)))) return null;
    // Decode only the required prefix, retaining the existing 5s/1MiB budget.
    // No apad or async resampling may fabricate coverage across a gap/tail.
    const covered = await decodedPrefixCovered(input, required, signal);
    if (signal?.aborted) throw new AudioAuxAbort();
    return covered &&
      await sameContainAudioInput(identity) && await sameContainAudioInput(outputIdentity)
      ? { outputIdentity, result, required, duration } : null;
  } catch (error) {
    if (signal?.aborted || error instanceof AudioAuxAbort || error instanceof AudioAuxCleanupError) throw error;
    return null;
  }
}

export async function hasProvenSelectedAudioLoss(params: SelectedAudioLossParams): Promise<boolean> {
  const evidence = await inspectSelectedAudioLoss(params);
  if (params.signal?.aborted) throw new AudioAuxAbort();
  return !!evidence;
}

async function decodedPrefixCovered(file: string, samples: number, signal?: AbortSignal) {
  const prefix = await runBoundedAudioAux(resolveFfmpegPath(), ["-v", "error", "-xerror", "-i", file,
    "-map", "0:a:0", "-vn", "-af",
    `aresample=48000,atrim=end_sample=${samples},asetpts=PTS-STARTPTS,astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.Number_of_samples:file='pipe\\:1'`,
    "-ac", "2", "-ar", "48000", "-frames:a", String(Math.ceil(samples / 1024)), "-f", "null", "-"],
    { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.probeMs, signal });
  return continuousSelectedAudioPrefix(prefix, samples);
}

/** Limit the selected window and decoded prefix, not the source file duration.
 * Late/large selections keep the existing proven-missing error. */
export const SELECTED_AUDIO_RECOVERY_LIMITS = {
  windowSamples: 48_000, prefixSamples: 240_000, outputBytes: 1024 * 1024,
} as const;

async function videoPackets(file: string, signal?: AbortSignal): Promise<string | null> {
  const raw = JSON.parse(await runBoundedAudioAux(resolveFfprobePath(), ["-v", "error", "-select_streams", "v:0",
    "-show_packets", "-show_entries", "packet=pts,dts,duration,size,data_hash", "-show_data_hash", "sha256", "-of", "json", file],
    { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.probeMs, signal }));
  if (!raw || !Array.isArray(raw.packets) || !raw.packets.length || raw.packets.length > 32) return null;
  const integer = (value: unknown) => typeof value === "number" ? Number.isSafeInteger(value)
    : typeof value === "string" && /^-?\d{1,20}$/.test(value);
  const packets = [];
  for (const p of raw.packets) {
    if (!p || ![p.pts, p.dts, p.duration, p.size].every(integer) || BigInt(p.duration) <= BigInt(0) || BigInt(p.size) <= BigInt(0) ||
        typeof p.data_hash !== "string" || !/^SHA256:[a-f0-9]{64}$/.test(p.data_hash)) return null;
    packets.push([String(p.pts), String(p.dts), String(p.duration), String(p.size), p.data_hash]);
  }
  return JSON.stringify(packets);
}

/** Selected API or pre-gain source part only. Reuse proven loss once; every recovery
 * failure retains its missing status, never publishes an unverified candidate. */
export async function recoverSelectedSegmentAudio(params: SelectedAudioLossParams): Promise<"unchanged" | "repaired" | "missing"> {
  const snapshot = { ...params };
  const { input, output, start, inputIdentity, signal } = snapshot;
  const evidence = await inspectSelectedAudioLoss(snapshot);
  if (signal?.aborted) throw new AudioAuxAbort();
  if (!evidence) return "unchanged";
  const missing = () => { if (signal?.aborted) throw new AudioAuxAbort(); return "missing" as const; };
  const first = sourceAudioSample(start), count = evidence.required - first;
  const oldVideo = evidence.result.streams![0], limits = SELECTED_AUDIO_RECOVERY_LIMITS;
  if (count > limits.windowSamples || evidence.required > limits.prefixSamples || evidence.outputIdentity.stat.size > limits.outputBytes ||
      oldVideo.start_time !== "0.000000" || String(oldVideo.start_pts) !== "0" ||
      typeof oldVideo.time_base !== "string" || !/^\d{1,10}\/\d{1,10}$/.test(oldVideo.time_base)) return missing();
  if (oldVideo.time_base.split("/").some(n => BigInt(n) <= BigInt(0))) return missing();
  let candidate: string | undefined;
  try {
    const originalPackets = await videoPackets(output, signal);
    if (!originalPackets || !await sameContainAudioInput(inputIdentity!) || !await sameContainAudioInput(evidence.outputIdentity)) return missing();
    candidate = `${output}.${randomUUID()}.mp4`;
    // No AAC frame-count limit: it would consume a slot for priming and lose
    // the source tail. Integer atrim + finite output time permits encoder flush.
    await runBoundedAudioAux(resolveFfmpegPath(), ["-v", "error", "-xerror", "-y", "-i", output, "-i", input,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af",
      `aresample=48000,atrim=start_sample=${first}:end_sample=${evidence.required},asetpts=PTS-STARTPTS`,
      "-ac", "2", "-ar", "48000", "-c:a", "aac", "-t", num(count / 48000),
      "-movie_timescale", "48000", "-movflags", "+faststart", "-fs", String(limits.outputBytes), candidate],
      { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.retryMs, signal });
    const candidateIdentity = await containAudioInputIdentity(candidate);
    if (!candidateIdentity || candidateIdentity.stat.size <= 0 || candidateIdentity.stat.size > limits.outputBytes) return missing();
    const result = await probe(candidate, signal);
    if (!result || result.format?.format_name !== "mov,mp4,m4a,3gp,3g2,mj2" || !Array.isArray(result.streams) ||
        result.streams.length !== 2 || result.streams.some(s => !s || typeof s !== "object")) return missing();
    const video = result.streams.find(s => s.codec_type === "video"), audio = result.streams.find(s => s.codec_type === "audio");
    if (!video || !audio || video.codec_name !== "h264" || video.time_base !== oldVideo.time_base ||
        audio.codec_name !== "aac" || audio.profile !== "LC" || audio.channels !== 2 || audio.sample_rate !== "48000" ||
        audio.time_base !== "1/48000" || audio.start_time !== "0.000000" || String(audio.start_pts) !== "0" ||
        String(audio.duration_ts) !== String(count) || !verifiedClockDuration(audio)) return missing();
    if (await videoPackets(candidate, signal) !== originalPackets || !await decodedPrefixCovered(candidate, count, signal)) return missing();
    const stable = await sameContainAudioInput(inputIdentity!) && await sameContainAudioInput(evidence.outputIdentity) &&
      await sameContainAudioInput(candidateIdentity);
    if (signal?.aborted) throw new AudioAuxAbort();
    if (!stable) return missing();
    await rename(candidate, output); // Commit point, after all verification.
    candidate = undefined;
    return "repaired";
  } catch (error) {
    if (signal?.aborted || error instanceof AudioAuxAbort || error instanceof AudioAuxCleanupError) throw error;
    return missing();
  } finally {
    if (candidate) await unlink(candidate).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}
