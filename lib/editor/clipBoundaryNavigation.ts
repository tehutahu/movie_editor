import type { EditorProject } from "./types";
import { getCurrentProject, updateEditorView, type CommandHistory } from "./commandHistory";

export type ClipBoundaryDirection = "previous" | "next";

/** All outer clip endpoints, in project seconds; never display/frame-rounded. */
export function clipBoundaryTarget(
  project: Pick<EditorProject, "clips" | "playheadSec" | "compositionDurationSec">,
  direction: ClipBoundaryDirection,
): number | undefined {
  const current = project.playheadSec, duration = project.compositionDurationSec;
  if ((direction !== "previous" && direction !== "next") || !Number.isFinite(duration) || duration < 0 ||
    !Number.isFinite(current) || current < 0 || current > duration) return;
  let nearest: number | undefined;
  for (const clip of project.clips) {
    if (!Number.isFinite(clip.timelineStartSec) || !Number.isFinite(clip.durationSec) || clip.durationSec <= 0) continue;
    for (const endpoint of [clip.timelineStartSec, clip.timelineStartSec + clip.durationSec]) {
      if (!Number.isFinite(endpoint) || endpoint < 0 || endpoint > duration) continue;
      const point = endpoint === 0 ? 0 : endpoint;
      if (direction === "previous" ? point < current && (nearest === undefined || point > nearest)
        : point > current && (nearest === undefined || point < nearest)) nearest = point;
    }
  }
  return nearest;
}

/** Recompute from adopted state, never from an event's potentially stale absolute target. */
export function applyClipBoundaryNavigation(
  history: CommandHistory, direction: ClipBoundaryDirection, expectedEpoch: number, currentEpoch: number, blocked: boolean,
): CommandHistory {
  if (blocked || expectedEpoch !== currentEpoch) return history;
  const target = clipBoundaryTarget(getCurrentProject(history), direction);
  return target === undefined ? history : updateEditorView(history, { playheadSec: target });
}
