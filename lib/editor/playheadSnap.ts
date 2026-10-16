import { clipFitsOnTrackAt, resolveNonOverlappingStart } from "@/lib/editor/clipOps";
import type { Clip } from "@/lib/editor/types";

export const PLAYHEAD_SNAP_DISTANCE_PX = 8;

/** Resolve a pointer move, giving overlap/zero constraints priority over snapping. */
export function resolvePlayheadSnappedStart({
  clips, clipId, trackId, rawStartSec, durationSec, playheadSec, pixelsPerSecond, disabled,
}: {
  clips: readonly Clip[];
  clipId: string;
  trackId: string;
  rawStartSec: number;
  durationSec: number;
  playheadSec: number;
  pixelsPerSecond: number;
  disabled: boolean;
}): number {
  const resolve = (start: number) => resolveNonOverlappingStart(clips, clipId, trackId, start, durationSec);
  if (!disabled) {
    // Stable order gives the start edge precedence when both distances tie.
    const candidates = [playheadSec, playheadSec - durationSec]
      .filter((start) => start >= 0 && Math.abs(start - rawStartSec) * pixelsPerSecond <= PLAYHEAD_SNAP_DISTANCE_PX + 1e-9)
      .sort((a, b) => {
        const difference = Math.abs(a - rawStartSec) - Math.abs(b - rawStartSec);
        return Math.abs(difference) < 1e-9 ? 0 : difference;
      });
    for (const candidate of candidates) {
      if (resolve(candidate) === candidate && clipFitsOnTrackAt(clips.filter((c) => c.id !== clipId), trackId, candidate, durationSec)) return candidate;
    }
  }
  // The legacy resolver can oscillate between adjacent blockers. Repair only
  // an invalid fallback by walking right across sorted neighbors once. Each
  // shift clears the current and all earlier neighbors, leaving a nonoverlapping
  // fixed point that the move command's second resolution cannot change.
  let start = resolve(rawStartSec);
  const neighbors = clips.filter((c) => c.id !== clipId && c.trackId === trackId)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec);
  for (const neighbor of neighbors) {
    if (!clipFitsOnTrackAt([neighbor], trackId, start, durationSec)) {
      start = neighbor.timelineStartSec + neighbor.durationSec;
    }
  }
  return start;
}
