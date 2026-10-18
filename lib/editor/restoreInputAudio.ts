import type { EditorProject } from "./types";
import { restoreSource } from "./restoreResult";

export type InputAudio =
  | { status: "none" }
  | { status: "unknown"; streamOrdinal: 0; streamIndex?: number }
  | { status: "known"; streamOrdinal: 0; streamIndex: number; sampleRateHz: number };

/** Match the existing restore target: first selected clip, first part's asset. */
export function restoreInputTarget(project: EditorProject, epoch: number) {
  const clip = project.clips.find(c => c.id === project.selectedClipIds[0]);
  if (project.clips.some(c => project.selectedClipIds.includes(c.id) && c.kind === "title")) return null;
  const part = clip?.parts?.[0], asset = project.assets.find(a => a.id === part?.assetId);
  if (!clip || !part || asset?.kind !== "video") return null;
  const source = restoreSource(asset);
  return { source, name: asset.displayName, key: JSON.stringify({ epoch, clipId: clip.id, part, source }) };
}

/** Untrusted read-only response; never guess a missing/invalid rate. */
export function parseInputAudio(raw: unknown): InputAudio {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("入力音声の情報が不正です。");
  const value = raw as Record<string, unknown>;
  if (value.status === "none") return { status: "none" };
  const index = value.streamIndex;
  if (value.streamOrdinal !== 0 || (index !== undefined && (!Number.isSafeInteger(index) || Number(index) < 0)))
    throw Error("入力音声の情報が不正です。");
  if (value.status === "unknown") return { status: "unknown", streamOrdinal: 0, ...(index === undefined ? {} : { streamIndex: Number(index) }) };
  if (value.status === "known" && index !== undefined && Number.isSafeInteger(value.sampleRateHz) && Number(value.sampleRateHz) > 0)
    return { status: "known", streamOrdinal: 0, streamIndex: Number(index), sampleRateHz: Number(value.sampleRateHz) };
  throw Error("入力音声の情報が不正です。");
}
