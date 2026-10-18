import type { EditorProject } from "./types";
import { dispatchCommand, getCurrentProject, type CommandHistory } from "./commandHistory";

/** Exact stored binary64 ends; no frame rounding or minimum-ten-second policy. */
export function contentDurationPlan(project: EditorProject): { end?: number; reason: string | null } {
  const duration = project.compositionDurationSec, position = project.playheadSec;
  if (!Number.isFinite(duration) || duration < .05 || duration > 86400 ||
      !Number.isFinite(position) || position < 0 || position > duration)
    return { reason: "現在の動画長または再生位置が不正です。" };
  if (!project.clips.length) return { reason: "クリップを追加してください。" };
  let end = 0;
  for (const clip of project.clips) {
    const value = clip.timelineStartSec + clip.durationSec;
    if (!Number.isFinite(clip.timelineStartSec) || clip.timelineStartSec < 0 ||
        !Number.isFinite(clip.durationSec) || clip.durationSec <= 0 || !Number.isFinite(value) || value > 86400)
      return { reason: "クリップの時刻が不正です。" };
    end = Math.max(end, value);
  }
  if (end < .05 || end > duration) return { reason: "クリップ終端が現在の動画長の範囲外です。" };
  if (end === duration) return { end, reason: "動画は最後のクリップまでの長さです。" };
  return { end, reason: null };
}

export function fitContentDuration(project: EditorProject): EditorProject | null {
  const plan = contentDurationPlan(project);
  return plan.reason || plan.end === undefined ? null : {
    ...project, compositionDurationSec: plan.end, playheadSec: Math.min(project.playheadSec, plan.end),
  };
}

export type ContentDurationSnapshot = { project: EditorProject; epoch: number; prefix: EditorProject[]; redo: EditorProject[] };
export function contentDurationSnapshot(history: CommandHistory, epoch: number): ContentDurationSnapshot {
  return { project: getCurrentProject(history), epoch, prefix: history.undoStack.slice(0, -1), redo: history.redoStack };
}
export function matchesContentDurationSnapshot(history: CommandHistory, epoch: number, snapshot: ContentDurationSnapshot): boolean {
  const current = getCurrentProject(history), previous = snapshot.project;
  return epoch === snapshot.epoch && current.clips === previous.clips && current.assets === previous.assets &&
    current.tracks === previous.tracks && current.compositionDurationSec === previous.compositionDurationSec &&
    current.compositionWidth === previous.compositionWidth && current.compositionHeight === previous.compositionHeight &&
    current.exportBaseName === previous.exportBaseName && history.redoStack === snapshot.redo &&
    history.undoStack.length === snapshot.prefix.length + 1 && snapshot.prefix.every((p, i) => p === history.undoStack[i]);
}
export function applyContentDuration(history: CommandHistory, snapshot: ContentDurationSnapshot, epoch: number, blocked: boolean): CommandHistory {
  if (blocked || !matchesContentDurationSnapshot(history, epoch, snapshot)) return history;
  return dispatchCommand(history, { type: "fitContentDuration" })?.history ?? history;
}

/** This action only observes the preview owner; it never pauses or changes its clock. */
export function contentDurationOwnerStopped(alive: boolean, playing: boolean, preparing: boolean, pending: boolean,
  currentIntent: number, expectedIntent: number): boolean {
  return alive && !playing && !preparing && !pending && currentIntent === expectedIntent;
}
