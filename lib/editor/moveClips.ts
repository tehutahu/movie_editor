import type { EditorProject } from "./types";
import { clipFitsOnTrackAt } from "./clipOps";
import { MAX_COMPOSITION_DURATION_SEC } from "./validateExportProject";
import { PLAYHEAD_SNAP_DISTANCE_PX } from "./playheadSnap";

export type GroupMovePlan = { deltaSec: number; reason: string | null };
const invalid = (deltaSec: number, reason: string): GroupMovePlan => ({ deltaSec, reason });
/** A single common translation; selected clips never resolve independently. */
export function planGroupMove(project: EditorProject, clipIds: readonly string[], requestedDelta: number): GroupMovePlan {
  const ids = new Set(clipIds), clips = project.clips.filter(c => ids.has(c.id));
  if (ids.size < 2 || ids.size !== clipIds.length || clips.length !== ids.size || !Number.isFinite(requestedDelta))
    return invalid(0, "移動するクリップを2つ以上選択してください。");
  if (clips.some(c => !Number.isFinite(c.timelineStartSec) || c.timelineStartSec < 0 || !Number.isFinite(c.durationSec) || c.durationSec <= 0 || !project.tracks.some(t => t.id === c.trackId)))
    return invalid(0, "クリップの時刻またはトラックが不正です。");
  const deltaSec = Math.max(requestedDelta, -Math.min(...clips.map(c => c.timelineStartSec)));
  if (deltaSec === 0) return { deltaSec: 0, reason: null };
  const others = project.clips.filter(c => !ids.has(c.id));
  for (const clip of clips) {
    const start = clip.timelineStartSec + deltaSec, end = start + clip.durationSec;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > MAX_COMPOSITION_DURATION_SEC)
      return invalid(deltaSec, "移動先が保存できる時間範囲を超えています。");
    // Within the supported 24-hour timeline, common-addition rounding must
    // remain below a nanosecond; do not normalize any source or duration.
    if (Math.abs((start - clip.timelineStartSec) - deltaSec) > 1e-9)
      return invalid(deltaSec, "時刻を必要な精度で移動できません。");
    if (!clipFitsOnTrackAt(others, clip.trackId, start, clip.durationSec))
      return invalid(deltaSec, "選択外のクリップと重なるため、まとめて移動できません。");
  }
  return { deltaSec, reason: null };
}

export function resolveGroupMove(project: EditorProject, clipIds: readonly string[], anchorId: string, requestedDelta: number, pixelsPerSecond: number, alt: boolean): GroupMovePlan {
  const raw = planGroupMove(project, clipIds, requestedDelta);
  if (!Number.isFinite(requestedDelta) || (!raw.reason && raw.deltaSec === 0)) return raw;
  const anchor = project.clips.find(c => c.id === anchorId && clipIds.includes(c.id));
  if (!anchor || !Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0 || alt) return raw;
  const candidates = [project.playheadSec - anchor.timelineStartSec, project.playheadSec - anchor.timelineStartSec - anchor.durationSec]
    .map((deltaSec, index) => ({ deltaSec, index, distance: Math.abs(deltaSec - raw.deltaSec) }))
    .filter(c => Number.isFinite(c.deltaSec) && c.distance * pixelsPerSecond <= PLAYHEAD_SNAP_DISTANCE_PX + 1e-9)
    .sort((a, b) => Math.abs(a.distance - b.distance) < 1e-9 ? a.index - b.index : a.distance - b.distance);
  if (candidates.length) {
    const snap = planGroupMove(project, clipIds, candidates[0].deltaSec);
    // Clamp/collision cannot silently convert a chosen snap into another one.
    if (!snap.reason && snap.deltaSec === candidates[0].deltaSec) return snap;
  }
  return raw;
}

export function moveClips(project: EditorProject, clipIds: readonly string[], deltaSec: number): EditorProject | null {
  const plan = planGroupMove(project, clipIds, deltaSec);
  if (plan.reason || plan.deltaSec === 0) return null;
  const ids = new Set(clipIds);
  const clips = project.clips.map(c => ids.has(c.id) ? { ...c, timelineStartSec: c.timelineStartSec + plan.deltaSec } : c);
  if (!clips.some((c, i) => c.timelineStartSec !== project.clips[i].timelineStartSec)) return null;
  return { ...project, clips, compositionDurationSec: Math.max(project.compositionDurationSec, ...clips.map(c => c.timelineStartSec + c.durationSec)) };
}

/** Immutable persistent references survive navigation/playback view updates. */
export type GroupMoveSnapshot = { project: EditorProject; epoch: number; zoom: number; clipIds: string[] };
export function groupMoveSnapshot(project: EditorProject, epoch: number, zoom: number): GroupMoveSnapshot {
  return { project, epoch, zoom, clipIds: [...project.selectedClipIds] };
}
export function matchesGroupMoveSnapshot(project: EditorProject, epoch: number, zoom: number, snapshot: GroupMoveSnapshot): boolean {
  const p = snapshot.project;
  return epoch === snapshot.epoch && zoom === snapshot.zoom && project.assets === p.assets && project.clips === p.clips && project.tracks === p.tracks &&
    project.compositionDurationSec === p.compositionDurationSec && project.compositionWidth === p.compositionWidth && project.compositionHeight === p.compositionHeight && project.exportBaseName === p.exportBaseName &&
    project.selectedClipIds.length === snapshot.clipIds.length && snapshot.clipIds.every(id => project.selectedClipIds.includes(id));
}
