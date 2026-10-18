import type { EditorProject } from "./types";
import { planGroupMove, type GroupMovePlan } from "./moveClips";
import { MAX_COMPOSITION_DURATION_SEC } from "./validateExportProject";
import { dispatchCommand, getCurrentProject, type CommandHistory } from "./commandHistory";

export type MoveToPlayheadSnapshot = {
  project: EditorProject;
  epoch: number;
  clipIds: string[];
  playheadSec: number;
  undoPrefix: EditorProject[];
  redoStack: EditorProject[];
};

export function planMoveSelectionToPlayhead(project: EditorProject): GroupMovePlan {
  const target = project.playheadSec, duration = project.compositionDurationSec;
  if (!Number.isFinite(target) || !Number.isFinite(duration) || duration < 0 || duration > MAX_COMPOSITION_DURATION_SEC ||
    target < 0 || target > duration || target > MAX_COMPOSITION_DURATION_SEC)
    return { deltaSec: 0, reason: "現在の再生位置には移動できません。" };
  const selected = new Set(project.selectedClipIds);
  const clips = project.clips.filter(clip => selected.has(clip.id));
  const earliest = Math.min(...clips.map(clip => clip.timelineStartSec));
  const deltaSec = target - earliest;
  const plan = planGroupMove(project, project.selectedClipIds, deltaSec);
  if (plan.reason) return plan;
  if (plan.deltaSec !== deltaSec) return { deltaSec, reason: "指定した再生位置へ移動できません。" };
  if (deltaSec === 0) return { deltaSec, reason: "選択群の先頭は再生位置にあります。" };
  const actualEarliest = Math.min(...clips.map(clip => clip.timelineStartSec + deltaSec));
  // Reuse the existing group-move precision ceiling, never an epsilon no-op.
  if (!Number.isFinite(actualEarliest) || Math.abs(actualEarliest - target) > 1e-9)
    return { deltaSec, reason: "再生位置へ必要な精度で移動できません。" };
  if (clips.every(clip => clip.timelineStartSec + deltaSec === clip.timelineStartSec))
    return { deltaSec, reason: "この位置ではクリップの時刻を変更できません。" };
  return { deltaSec, reason: null };
}

/** Capture the click's explicit position; zoom and selection ordering are view-only. */
export function moveToPlayheadSnapshot(history: CommandHistory, epoch: number): MoveToPlayheadSnapshot {
  const project = getCurrentProject(history);
  return { project, epoch, clipIds: [...project.selectedClipIds], playheadSec: project.playheadSec,
    undoPrefix: history.undoStack.slice(0, -1), redoStack: history.redoStack };
}

export function matchesMoveToPlayheadSnapshot(history: CommandHistory, epoch: number, snapshot: MoveToPlayheadSnapshot): boolean {
  const current = getCurrentProject(history), old = snapshot.project;
  const selected = new Set(current.selectedClipIds), expected = new Set(snapshot.clipIds);
  return selected.size === current.selectedClipIds.length && expected.size === snapshot.clipIds.length &&
    epoch === snapshot.epoch && current.playheadSec === snapshot.playheadSec &&
    current.clips === old.clips && current.assets === old.assets && current.tracks === old.tracks &&
    current.compositionDurationSec === old.compositionDurationSec && current.compositionWidth === old.compositionWidth &&
    current.compositionHeight === old.compositionHeight && current.exportBaseName === old.exportBaseName &&
    selected.size === expected.size && snapshot.clipIds.every(id => selected.has(id)) &&
    history.redoStack === snapshot.redoStack && history.undoStack.length === snapshot.undoPrefix.length + 1 &&
    snapshot.undoPrefix.every((project, index) => project === history.undoStack[index]);
}

/** React adoption stays pure; stale position, content, capture or locks reject atomically. */
export function applyMoveSelectionToPlayhead(
  history: CommandHistory, snapshot: MoveToPlayheadSnapshot, epoch: number, blocked: boolean, pointerCaptured: boolean,
): CommandHistory {
  if (blocked || pointerCaptured || !matchesMoveToPlayheadSnapshot(history, epoch, snapshot)) return history;
  const current = getCurrentProject(history), plan = planMoveSelectionToPlayhead(current);
  if (plan.reason) return history;
  return dispatchCommand(history, { type: "moveMany", clipIds: current.selectedClipIds, deltaSec: plan.deltaSec })?.history ?? history;
}
