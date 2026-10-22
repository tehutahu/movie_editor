/** Selected-source downloads retain the source audio, including silent tracks.
 * This diagnoses one known missing-track family; it does not repair long media
 * or apply to composition renders, where muting may intentionally drop audio. */
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
async function probe(file: string) {
  return JSON.parse(await runBoundedAudioAux(resolveFfprobePath(),
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.probeMs })) as FfProbeJson;
}

/** True only when known metadata AND actual continuous decoded samples prove
 * source audio exists throughout this selection but the final output lacks it.
 * Unknown, short, discontinuous or over-budget diagnostics preserve old output.
 * Caller owns publication/deletion and must check its job output path first. */
export async function hasProvenSelectedAudioLoss(params: {
  input: string; output: string; start: number; end: number;
  /** Must be captured by the selected API before legacy extraction starts. */
  inputIdentity: Awaited<ReturnType<typeof containAudioInputIdentity>>;
}): Promise<boolean> {
  const { input, output, start, end, inputIdentity: identity } = params, duration = end - start;
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < 1 / 30) return false;
  try {
    if (!identity || identity.file !== input || !await sameContainAudioInput(identity)) return false;
    const required = sourceAudioSample(start) + sourceAudioSample(duration);
    if (!Number.isSafeInteger(required) || required <= 0) return false;
    const outputIdentity = await containAudioInputIdentity(output);
    if (!outputIdentity) return false;
    const result = await probe(output);
    if (!result || result.format?.format_name !== "mov,mp4,m4a,3gp,3g2,mj2" ||
        !Array.isArray(result.streams) || result.streams.length !== 1) return false;
    const video = result.streams[0];
    if (!video || video.codec_type !== "video" || video.codec_name !== "h264" ||
        typeof video.start_time !== "string" || typeof video.duration !== "string") return false;
    const outputStart = Number(video.start_time), outputDuration = Number(video.duration);
    if (!Number.isFinite(outputStart) || outputStart < 0 || outputStart > 1 / 30 ||
        !Number.isFinite(outputDuration) || outputDuration < duration - 1 / 30 || outputDuration > duration + 1 / 30) return false;
    const source = await probe(input), clock = positiveAudioClockFromProbe(source);
    if (!clock) return false;
    const videoDuration = verifiedClockDuration(source.streams!.find(s => s.codec_type === "video")!);
    if (!videoDuration || ![videoDuration, clock.audioDuration].every(limit =>
      verifiedClockRangeCovered(limit, num(start), num(duration)))) return false;
    // Decode only the required prefix, retaining the existing 5s/1MiB budget.
    // No apad or async resampling may fabricate coverage across a gap/tail.
    const prefix = await runBoundedAudioAux(resolveFfmpegPath(), ["-v", "error", "-xerror", "-i", input,
      "-map", "0:a:0", "-vn", "-af",
      `aresample=48000,atrim=end_sample=${required},asetpts=PTS-STARTPTS,astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.Number_of_samples:file='pipe\\:1'`,
      "-ac", "2", "-ar", "48000", "-frames:a", String(Math.ceil(required / 1024)), "-f", "null", "-"],
      { timeoutMs: CONTAIN_AUDIO_AUX_BUDGET.probeMs });
    return continuousSelectedAudioPrefix(prefix, required) &&
      await sameContainAudioInput(identity) && await sameContainAudioInput(outputIdentity);
  } catch (error) {
    if (error instanceof AudioAuxAbort || error instanceof AudioAuxCleanupError) throw error;
    return false;
  }
}
