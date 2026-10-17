import { probeMedia, type FfProbeJson } from "./ffmpeg";
import type { InputAudio } from "./editor/restoreInputAudio";

/** The restore filter [0:a] uses a:0, regardless of default disposition. */
export function inputAudioFromProbe(probe: FfProbeJson): InputAudio {
  const stream = probe.streams?.find(s => s.codec_type === "audio");
  if (!stream) return { status: "none" };
  const index = Number.isSafeInteger(stream.index) && Number(stream.index) >= 0 ? Number(stream.index) : undefined;
  const rate = typeof stream.sample_rate === "string" && /^\d+$/.test(stream.sample_rate) ? Number(stream.sample_rate) : NaN;
  if (index !== undefined && Number.isSafeInteger(rate) && rate > 0)
    return { status: "known", streamIndex: index, streamOrdinal: 0, sampleRateHz: rate };
  return { status: "unknown", streamOrdinal: 0, ...(index === undefined ? {} : { streamIndex: index }) };
}
export async function probeRestoreInputAudio(input: string): Promise<InputAudio> {
  return inputAudioFromProbe(await probeMedia(input));
}
