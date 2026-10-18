import { isMediaClip } from "./types";
import type { Clip, EditorProject } from "./types";
export const clipAudioGain = (clip: Clip): number => clip.audioGain ?? 1;
export const validAudioGain = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
export function clipHasVideo(project: EditorProject, clip: Clip): boolean {
  return isMediaClip(clip) && clip.parts.some(p => project.assets.some(a => a.id === p.assetId && a.kind === "video"));
}
/** Exact round-trip decimal, shared by both audio graphs (never time rounding). */
export function formatAudioGain(gain: number): string {
  if (!validAudioGain(gain)) throw new Error("音量は0〜1で指定してください。");
  const s = String(gain);
  if (!s.includes("e")) return s;
  const [mantissa, exponent] = s.split("e"), [whole, fraction = ""] = mantissa.split(".");
  const digits = whole + fraction, point = whole.length + Number(exponent);
  return point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
}
export function audioGainFilter(clip: Clip): string {
  const gain = clipAudioGain(clip);
  return gain === 1 ? "" : `volume=${formatAudioGain(gain)},`;
}
export function setClipAudioGain(project: EditorProject, clipIds: readonly string[], gain: number): EditorProject | null {
  const ids = new Set(clipIds), targets = project.clips.filter(c => ids.has(c.id));
  if (!validAudioGain(gain) || !ids.size || ids.size !== clipIds.length || targets.length !== ids.size || targets.some(c => !clipHasVideo(project, c))) return null;
  if (!targets.some(c => clipAudioGain(c) !== gain)) return null;
  return { ...project, clips: project.clips.map(c => {
    if (!isMediaClip(c) || !ids.has(c.id) || clipAudioGain(c) === gain) return c;
    const { audioGain: _old, ...rest } = c;
    return gain === 1 ? rest : { ...rest, audioGain: gain };
  }) };
}
/** Image-only gains can be inherited by split but cannot conflict with audio. */
export function mergedAudioGain(project: EditorProject, clips: readonly Clip[]): number | null {
  if (!clips.length) return null;
  const audible = clips.filter(c => clipHasVideo(project, c));
  const gain = clipAudioGain(audible[0] ?? clips[0]);
  return audible.every(c => clipAudioGain(c) === gain) ? gain : null;
}
export type ClipAudioSnapshot = { epoch: number; selection: string[]; clipIds: string[]; identity: string };
export function clipAudioSnapshot(project: EditorProject, epoch: number): ClipAudioSnapshot {
  const selection = [...project.selectedClipIds], selected = selection.map(id => project.clips.find(c => c.id === id));
  const clipIds = selected.filter((c): c is Clip => Boolean(c && clipHasVideo(project, c))).map(c => c.id);
  const assetIds = new Set(selected.flatMap(c => c && isMediaClip(c) ? c.parts.map(p => p.assetId) : []));
  return { epoch, selection, clipIds, identity: JSON.stringify({ selected, assets: project.assets.filter(a => assetIds.has(a.id)) }) };
}
export function matchesClipAudioSnapshot(project: EditorProject, epoch: number, snapshot: ClipAudioSnapshot): boolean {
  if (epoch !== snapshot.epoch || project.selectedClipIds.length !== snapshot.selection.length || !snapshot.selection.every(id => project.selectedClipIds.includes(id))) return false;
  // Selection order is irrelevant; normalize it to the captured order.
  return clipAudioSnapshot({ ...project, selectedClipIds: snapshot.selection }, epoch).identity === snapshot.identity;
}
