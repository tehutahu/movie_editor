import { describe, expect, it } from "vitest";
import { resolvePlayheadSnappedStart } from "./playheadSnap";
import type { Clip } from "./types";
import { clipFitsOnTrackAt, resolveNonOverlappingStart } from "./clipOps";

const clip = (id: string, start: number, duration: number, trackId = "t1") => ({ id, timelineStartSec: start, durationSec: duration, trackId }) as Clip;
const resolve = (overrides: Partial<Parameters<typeof resolvePlayheadSnappedStart>[0]> = {}) => resolvePlayheadSnappedStart({
  clips: [clip("moving", 0, 2)], clipId: "moving", trackId: "t1", rawStartSec: 3.95,
  durationSec: 2, playheadSec: 4, pixelsPerSecond: 80, disabled: false, ...overrides,
});

describe("pointer move playhead snapping", () => {
  it("snaps the start and end edges", () => {
    expect(resolve()).toBe(4);
    expect(resolve({ rawStartSec: 2.05 })).toBe(2);
  });
  it.each([20, 80, 160, 320])("uses an inclusive 8 CSS px threshold at %s px/sec", (pps) => {
    expect(resolve({ rawStartSec: 4 - 8 / pps, pixelsPerSecond: pps })).toBe(4);
    const outside = 4 - 8.01 / pps;
    expect(resolve({ rawStartSec: outside, pixelsPerSecond: pps })).toBe(outside);
  });
  it("chooses the nearest edge and gives the start edge precedence on ties", () => {
    expect(resolve({ rawStartSec: 3.96, durationSec: 0.1 })).toBe(4);
    expect(resolve({ rawStartSec: 3.94, durationSec: 0.1 })).toBe(3.9);
    expect(resolve({ rawStartSec: 3.95, durationSec: 0.1 })).toBe(4);
  });
  it("rejects negative end candidates and retains the zero boundary", () => {
    expect(resolve({ rawStartSec: 0.03, playheadSec: 0, durationSec: 0.05 })).toBe(0);
    expect(resolve({ rawStartSec: 0.05, playheadSec: 0.02 })).toBe(0.02);
    expect(resolve({ rawStartSec: -0.2, disabled: true })).toBe(0);
  });
  it("does not clamp legal moves to the old composition duration", () => {
    expect(resolve({ rawStartSec: 40, playheadSec: 4 })).toBe(40);
  });
  it("rejects an obstructed snap and tries the other edge", () => {
    expect(resolve({ durationSec: 0.1, rawStartSec: 3.95, clips: [clip("obstacle", 4, 2)] })).toBe(3.9);
  });
  it("falls back to the original overlap resolver when snapping is obstructed", () => {
    expect(resolve({ clips: [clip("right", 4, 2)] })).toBe(2);
  });
  it.each([
    [clip("left", 0, 4), clip("right", 4, 2)],
    [clip("third", 6, 3), clip("right", 4, 2), clip("left", 0, 4)],
    [clip("outer", 0, 8), clip("inner", 2, 2), clip("next", 8, 2)],
  ])("repairs an oscillating fallback to a nonoverlapping commit fixed point (%j)", (...neighbors) => {
    const start = resolve({ clips: neighbors });
    expect(clipFitsOnTrackAt(neighbors, "t1", start, 2)).toBe(true);
    expect(resolveNonOverlappingStart(neighbors, "moving", "t1", start, 2)).toBe(start);
    if (neighbors.length === 2) expect(start).toBe(6);
  });
  it("ignores the moving clip and other tracks", () => {
    expect(resolve({ clips: [clip("moving", 4, 2), clip("other", 4, 2, "t2")] })).toBe(4);
  });
  it("Alt disables only playhead snapping, preserving overlap avoidance", () => {
    expect(resolve({ disabled: true })).toBe(3.95);
    expect(resolve({ disabled: true, clips: [clip("block", 3, 3)] })).toBe(6);
  });
  it("derives live playhead and zoom results from the unchanged raw position", () => {
    expect(resolve({ rawStartSec: 3.93, playheadSec: 4 })).toBe(4);
    expect(resolve({ rawStartSec: 3.93, playheadSec: 4.2 })).toBe(3.93);
    expect(resolve({ rawStartSec: 3.93, pixelsPerSecond: 160 })).toBe(3.93);
  });
});
