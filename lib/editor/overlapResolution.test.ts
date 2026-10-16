import { describe, expect, it } from "vitest";
import { clipFitsOnTrackAt, moveClip, resolveNonOverlappingStart } from "./clipOps";
import { createEmptyProject, clipFromAsset } from "./project";
import { resolvePlayheadSnappedStart } from "./playheadSnap";
import type { Asset, Clip } from "./types";

const asset: Asset = { id: "source", kind: "video", displayName: "source.mp4", streamUrl: "/source", sourceDurationSec: 20, ext: "mp4" };
const blocker = (id: string, start: number, duration: number, trackId = "t1") =>
  ({ ...clipFromAsset({ asset, trackId, timelineStartSec: start, durationSec: duration }), id });
const resolve = (clips: Clip[], desired = 3.95, duration = 2, id = "moving") =>
  resolveNonOverlappingStart(clips, id, "t1", desired, duration);

describe("overlap resolver convergence", () => {
  it("resolves adjacent blockers to 6 and remains there on repeated calls", () => {
    const clips = [blocker("left", 0, 4), blocker("right", 4, 2)];
    let start = resolve(clips);
    expect(start).toBe(6);
    for (let pass = 0; pass < 5; pass++) {
      expect(clipFitsOnTrackAt(clips, "t1", start, 2)).toBe(true);
      start = resolve(clips, start);
      expect(start).toBe(6);
    }
  });

  it.each([
    [blocker("c", 6, 3), blocker("a", 0, 4), blocker("b", 4, 2)],
    [blocker("outer", 0, 8), blocker("inner", 2, 2), blocker("tail", 8, 2)],
    [blocker("a", 0, 4), blocker("b", 4.5, 2), blocker("c", 7, 2)],
  ])("finds a legal tail through unsorted, contained or insufficient gaps (%j)", (...clips) => {
    const before = structuredClone(clips);
    const start = resolve(clips);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(clipFitsOnTrackAt(clips, "t1", start, 2)).toBe(true);
    expect(resolve(clips, start)).toBe(start);
    expect(resolve([...clips].reverse())).toBe(start);
    expect(clips).toEqual(before);
  });

  it("preserves previously valid nearest-edge results, empty space and zero clamping", () => {
    const clips = [blocker("a", 0, 4), blocker("b", 8, 2)];
    expect(resolve(clips, 2)).toBe(4);
    expect(resolve(clips, 7)).toBe(6);
    expect(resolve(clips, 5)).toBe(5);
    expect(resolve([], -2)).toBe(0);
    expect(resolve([], 40)).toBe(40);
  });

  it("keeps adjacency and the existing overlap epsilon", () => {
    const clips = [blocker("a", 0, 4)];
    expect(resolve(clips, 4)).toBe(4);
    expect(resolve(clips, 4 - 0.5e-9)).toBe(4 - 0.5e-9);
    expect(resolve(clips, 4 - 2e-9)).toBe(4);
  });

  it("excludes self and other tracks", () => {
    expect(resolve([blocker("moving", 4, 2), blocker("other", 4, 2, "t2")], 4)).toBe(4);
  });

  it("keeps UI preview and the common move command at the same repaired position", () => {
    const base = createEmptyProject();
    const moving = blocker("moving", 10, 2);
    const project = { ...base, assets: [asset], clips: [blocker("a", 0, 4), blocker("b", 4, 2), moving] };
    const preview = resolvePlayheadSnappedStart({ clips: project.clips, clipId: moving.id, trackId: "t1", rawStartSec: 3.95,
      durationSec: 2, playheadSec: 4, pixelsPerSecond: 80, disabled: false });
    expect(preview).toBe(6);
    const moved = moveClip(project, moving.id, preview, "t1");
    expect(moved.clips.find(c => c.id === moving.id)?.timelineStartSec).toBe(preview);
    expect(moved.clips.find(c => c.id === moving.id)?.parts).toEqual(moving.parts);
    expect(project.clips.at(-1)?.timelineStartSec).toBe(10);
  });
});
