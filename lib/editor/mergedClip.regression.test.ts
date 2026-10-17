import { describe, expect, it } from "vitest";
import { resizeClip, partAndSourceAtClipOffset } from "./clipOps";
import { createEmptyProject } from "./project";
import { createCommandHistory, dispatchCommand, getCurrentProject, undo, redo } from "./commandHistory";
import type { Asset, EditorProject } from "./types";

const assets: Asset[] = [
  { id: "a", kind: "video", ext: "mp4", streamUrl: "/a", displayName: "a", sourceDurationSec: 10 },
  { id: "b", kind: "video", ext: "mp4", streamUrl: "/b", displayName: "b", sourceDurationSec: 8 },
  { id: "i", kind: "image", ext: "png", streamUrl: "/i", displayName: "i" },
];
function fixture(first = "a", last = "b"): EditorProject {
  const p = createEmptyProject();
  return { ...p, assets, compositionDurationSec: 6, clips: [{ id: "c", trackId: p.tracks[0]!.id, timelineStartSec: 0, durationSec: 6,
    transform: { x: .5, y: .5, scale: 1 }, parts: [
      { assetId: first, sourceInSec: 0, sourceOutSec: 3 },
      { assetId: last, sourceInSec: 2, sourceOutSec: 5 },
    ] }] };
}
describe("merged clip resize regression #15", () => {
  it.each([2.99, 3, 3.01, 5, 6])("trims at %s without replacing later media", (duration) => {
    const p = fixture();
    const before = structuredClone(p);
    const result = resizeClip(p, "c", duration, assets);
    if (duration === p.clips[0]!.durationSec) expect(result).toBeNull();
    else expect(result).not.toBeNull();
    expect(p).toEqual(before);
    const c = (result ?? p).clips[0]!;
    expect(c.durationSec).toBeCloseTo(duration);
    expect(c.parts).toEqual(duration <= 3 ? [{ assetId: "a", sourceInSec: 0, sourceOutSec: duration }] : [p.clips[0]!.parts[0], { assetId: "b", sourceInSec: 2, sourceOutSec: duration - 1 }]);
    expect(p.clips[0]!.parts).toHaveLength(2);
    if (duration > 3) expect(partAndSourceAtClipOffset(c, 3)?.part.assetId).toBe("b");
  });
  it.each([["a", "b", 20, 9], ["i", "b", 8, 8], ["a", "i", 12, 12]])("extends only the tail (%s → %s)", (first, last, duration, expected) => {
    const p = fixture(first as string, last as string);
    const c = resizeClip(p, "c", duration as number, assets)!.clips[0]!;
    expect(c.durationSec).toBe(expected);
    expect(c.parts[0]).toEqual(p.clips[0]!.parts[0]);
    expect(c.parts[1]!.assetId).toBe(last);
  });
  it("restores all parts through undo/redo after trim across a boundary", () => {
    const p = fixture("i");
    const h = dispatchCommand(createCommandHistory(p), { type: "resize", clipId: "c", newDurationSec: 4 })!.history;
    expect(getCurrentProject(h).clips[0]!.parts[1]!.sourceOutSec).toBe(3);
    expect(getCurrentProject(undo(h)!).clips).toEqual(p.clips);
    expect(getCurrentProject(redo(undo(h)!)!).clips).toEqual(getCurrentProject(h).clips);
  });
});

it("extends the current tail after trimming across a boundary; Undo recovers discarded parts", () => {
  const p = fixture();
  for (const boundary of [2.99, 3, 3.01]) {
    const trimmed = resizeClip(p, "c", boundary, assets)!;
    const extended = resizeClip(trimmed, "c", 7, assets)!;
    expect(extended.clips[0]!.parts.map((part) => part.assetId)).toEqual(boundary <= 3 ? ["a"] : ["a", "b"]);
    expect(extended.clips[0]!.durationSec).toBeCloseTo(7);
  }
});
it("keeps a single video's source start, clamps extension and rejects nonfinite input", () => {
  const p = fixture();
  p.clips[0]!.parts = [{ assetId: "a", sourceInSec: 2, sourceOutSec: 5 }];
  p.clips[0]!.durationSec = 3;
  expect(resizeClip(p, "c", 20, assets)!.clips[0]).toMatchObject({ durationSec: 8, parts: [{ assetId: "a", sourceInSec: 2, sourceOutSec: 10 }] });
  expect(resizeClip(p, "c", NaN, assets)).toBeNull();
});
