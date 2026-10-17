import { describe, expect, it } from "vitest";
import type { Clip } from "./editor/types";
import { multipartDurationArgument, planMultipartVideo } from "./multipartTiming";
function clip(start: number, spans: [number, number][], drift = 0): Clip {
  return { id: "c", trackId: "t", timelineStartSec: start,
    durationSec: spans.reduce((sum, [a, b]) => sum + b - a, 0) + drift,
    parts: spans.map(([sourceInSec, sourceOutSec], i) => ({ assetId: String(i), sourceInSec, sourceOutSec })),
    transform: { x: .5, y: .5, scale: 1 } };
}
describe("canonical-decimal multipart output ownership", () => {
  it("uses the global sample phase, with selected source export recalculated at zero", () => {
    const c = clip(1.75, [[1, 1.25], [.5, 1.5]]), original = structuredClone(c);
    expect(planMultipartVideo(c)).toEqual({ firstFrame: 53, endFrame: 90, parts: [
      { firstFrame: 53, endFrame: 60, frames: 7 }, { firstFrame: 60, endFrame: 90, frames: 30 }] });
    expect(planMultipartVideo({ ...c, timelineStartSec: 0 }).parts.map(p => p.frames)).toEqual([8, 30]);
    expect(c).toEqual(original);
  });
  it.each([
    [0, [[0, .24], [0, 1]], 8],
    [.1, [[0, .2], [0, 1]], 9],
    [0, [[.1, .4], [0, 1]], 9],
    [86390.1, [[0, .2], [0, 1]], 2591709],
    [0, [[0, .3000000001], [0, 1]], 10],
    [1.75, [[0, .2500000001], [0, 1]], 61],
    [0, [[0, .2999999999], [0, 1]], 9],
  ] as [number, [number, number][], number][])("plans start %s without epsilon snapping", (start, spans, endFrame) => {
    expect(planMultipartVideo(clip(start, spans)).parts[0].endFrame).toBe(endFrame);
  });
  it("preserves micro parts with zero samples and distinguishes one owned sample", () => {
    const noFrame = clip(0, [[0, .01], [0, 1e-10], [0, .99]]);
    expect(planMultipartVideo(noFrame).parts.map(p => p.frames)).toEqual([1, 0, 30]);
    expect(noFrame.parts).toHaveLength(3);
    const oneFrame = clip(1.75, [[0, .25], [0, 1e-10], [0, 1]]);
    expect(planMultipartVideo(oneFrame).parts.map(p => p.frames)).toEqual([7, 1, 30]);
  });
  it.each([0, 5e-7, -5e-7, 1e-6, -1e-6])("keeps declared drift %s outside internal boundaries", drift => {
    const c = clip(.1, [[.1, .4], [0, .2]], drift);
    const before = structuredClone(c), plan = planMultipartVideo(c);
    expect(plan.parts.map(p => p.endFrame)).toEqual([12, 18]);
    expect(c).toEqual(before);
  });
  it("does not accumulate per-part frame-duration rounding across 50 parts", () => {
    const c = clip(.17, Array.from({ length: 50 }, () => [0, .05001] as [number, number]));
    const plan = planMultipartVideo(c);
    expect(plan.firstFrame).toBe(6); expect(plan.endFrame).toBe(81);
    expect(plan.parts.reduce((s, p) => s + p.frames, 0)).toBe(75);
    expect(plan.parts.map(p => p.frames).every(n => n === 1 || n === 2)).toBe(true);
  });
  it("rejects the unsupported huge decimal/binary domain mismatch, without rewriting the model", () => {
    const c = clip(0, [[1e20, 1e20 + 32768], [0, 1]]), before = structuredClone(c);
    expect(() => planMultipartVideo(c)).toThrow(/時刻精度/); expect(c).toEqual(before);
  });
  it("accepts exponent notation and rejects invalid finite or nonpositive intervals", () => {
    expect(planMultipartVideo(clip(1e-7, [[0, 2e-7], [0, .1]])).parts.map(p => p.frames)).toEqual([0, 3]);
    for (const c of [clip(0, [[0, 0]]), clip(0, [[0, Infinity]]), clip(NaN, [[0, 1]])])
      expect(() => planMultipartVideo(c)).toThrow(/時刻精度/);
  });
});

it("formats ffmpeg CLI durations without changing their numeric value", () => {
  for (const value of [1e-10, 1e-7, 1e21, .05001, 0]) {
    const argument = multipartDurationArgument(value);
    expect(argument).toMatch(/^\d+(\.\d+)?$/); expect(Number(argument)).toBe(value);
  }
});
