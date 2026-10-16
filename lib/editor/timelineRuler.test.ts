import { describe, expect, it } from "vitest";
import { timelineRulerMarks } from "./timelineRuler";

describe("timeline ruler label spacing", () => {
  it.each([[20, 5], [40, 2], [60, 2], [80, 1], [320, 1]])("uses readable integer marks at %s px/sec", (pps, step) => {
    const marks = timelineRulerMarks(30, pps);
    expect(marks).toEqual(Array.from({ length: Math.floor(30 / step) + 1 }, (_, index) => index * step));
    expect(step * pps).toBeGreaterThanOrEqual(80);
  });
  it.each([[16, 10, 5], [40, 5, 2], [80, 2, 1]])("chooses the smallest nice step at the %s px/sec boundary", (pps, before, at) => {
    expect(timelineRulerMarks(30, pps - 1e-6)[1]).toBe(before);
    expect(timelineRulerMarks(30, pps)[1]).toBe(at);
    expect(timelineRulerMarks(30, pps + 1e-6)[1]).toBe(at);
  });
  it("preserves the old ceil extent without appending a crowded endpoint", () => {
    expect(timelineRulerMarks(0, 80)).toEqual([0]);
    expect(timelineRulerMarks(0.1, 80)).toEqual([0, 1]);
    expect(timelineRulerMarks(1.2, 20)).toEqual([0]);
    expect(timelineRulerMarks(6, 20)).toEqual([0, 5]);
  });
  it("uses the same 1/2/5 progression beyond the current zoom range", () => {
    expect(timelineRulerMarks(100, 1.6)).toEqual([0, 50, 100]);
    expect(timelineRulerMarks(100, 0.8)).toEqual([0, 100]);
  });
  it.each([20, 80, 320])("handles the 24-hour boundary at %s px/sec", (pps) => {
    const marks = timelineRulerMarks(86400, pps);
    expect(marks[0]).toBe(0);
    expect(marks.at(-1)).toBe(86400);
    expect(marks.every(Number.isInteger)).toBe(true);
    if (pps >= 80) expect(marks).toHaveLength(86401); // Not virtualization.
  });
  it.each([[NaN, 80], [Infinity, 80], [-1, 80], [10, NaN], [10, Infinity], [10, 0], [10, -1], [Number.MAX_VALUE, 80], [10, Number.MIN_VALUE], [10, 80 / 1.5e308]])("rejects invalid or unrepresentable inputs (%s,%s)", (duration, pps) => {
    expect(timelineRulerMarks(duration, pps)).toEqual([]);
  });
});
