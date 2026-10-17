import { describe, expect, it } from "vitest";
import { addAssetAtPlayhead, assetAdditionTrack } from "./addAssetAtPlayhead";
import { clipFromAsset, createEmptyProject, defaultTransformForTrack } from "./project";
import { canRedo, createCommandHistory, dispatchCommand, getCurrentProject, redo, undo, updateEditorView } from "./commandHistory";
import { projectContentKey } from "./projectDocument";
import type { Asset, EditorProject } from "./types";
const video: Asset = { id: "video", kind: "video", displayName: "portrait.mp4", streamUrl: "/video", ext: "mp4", sourceDurationSec: 2, width: 360, height: 640 };
const image: Asset = { id: "image", kind: "image", displayName: "still.png", streamUrl: "/image", ext: "png", width: 640, height: 360 };
function base(): EditorProject {
  return { ...createEmptyProject(), assets: [video, image], tracks: [{ id: "t2", order: 1 }, { id: "t1", order: 0 }], playheadSec: 3 };
}
function existing(id: string, start: number, trackId = "t1", durationSec = 2) {
  return { ...clipFromAsset({ asset: video, trackId, timelineStartSec: start, durationSec }), id };
}
describe("explicit asset addition", () => {
  it("uses selection order across tracks, skips stale ids, then uses the first visible track", () => {
    const p = { ...base(), clips: [existing("one", 0), existing("two", 0, "t2")], selectedClipIds: ["stale", "two", "one"] };
    expect(assetAdditionTrack(p)?.id).toBe("t2");
    expect(assetAdditionTrack({ ...p, selectedClipIds: ["one", "two"] })?.id).toBe("t1");
    expect(assetAdditionTrack({ ...p, selectedClipIds: ["stale"] })?.id).toBe("t1");
    expect(assetAdditionTrack({ ...p, tracks: [] })).toBeUndefined();
  });
  it("matches existing clip defaults, preserves first auto resolution, and selects the new clip", () => {
    const p = base(); const before = structuredClone(p);
    const next = addAssetAtPlayhead(p, video.id, "new")!;
    expect(next.clips[0]).toEqual({ id: "new", trackId: "t1", timelineStartSec: 3, durationSec: 2,
      parts: [{ assetId: video.id, sourceInSec: 0, sourceOutSec: 2 }], transform: defaultTransformForTrack(0, 1) });
    expect(next.compositionWidth).toBe(1080); expect(next.compositionHeight).toBe(1920);
    expect(next.selectedClipIds).toEqual(["new"]); expect(next.playheadSec).toBe(3);
    expect(p).toEqual(before);
  });
  it("uses image five seconds and preserves an existing composition", () => {
    const p = { ...base(), clips: [existing("old", 20)], compositionWidth: 640, compositionHeight: 640 };
    const next = addAssetAtPlayhead(p, image.id, "new")!;
    expect(next.clips.at(-1)?.durationSec).toBe(5);
    expect(next.clips.at(-1)?.parts).toEqual([{ assetId: image.id, sourceInSec: 0, sourceOutSec: 5 }]);
    expect([next.compositionWidth, next.compositionHeight]).toEqual([640, 640]);
  });
  it.each([
    [[], 7, 7],
    [[existing("block", 4)], 4, 2],
    [[existing("a", 0, "t1", 4), existing("b", 4)], 3.95, 6],
    [[existing("block", 4, "t2")], 4, 4],
  ])("uses the common resolver without moving existing clips (%j)", (clips, desired, expected) => {
    const p = { ...base(), clips, playheadSec: desired };
    const next = addAssetAtPlayhead(p, video.id, "new")!;
    expect(next.clips.at(-1)?.timelineStartSec).toBe(expected);
    expect(next.clips.slice(0, -1)).toEqual(clips);
  });
  it("resolves repeated additions at the unchanged playhead", () => {
    let p = { ...base(), playheadSec: 0 };
    p = addAssetAtPlayhead(p, video.id, "one")!; p = addAssetAtPlayhead(p, video.id, "two")!;
    p = addAssetAtPlayhead(p, video.id, "three")!;
    expect(p.clips.map(c => c.timelineStartSec)).toEqual([0, 2, 4]);
  });
  it("commits first size, selection and clip as one undoable edit", () => {
    const p = base(); let h = createCommandHistory(p);
    h = dispatchCommand(h, { type: "addAssetAtPlayhead", assetId: video.id, clipId: "new" })!.history;
    expect(h.undoStack).toHaveLength(2); const next = getCurrentProject(h);
    h = undo(h)!; expect(getCurrentProject(h)).toEqual(p);
    h = redo(h)!; expect(getCurrentProject(h)).toEqual(next);
  });
  it("invalid asset/track or duplicate id is no-op and preserves pending Redo and dirty key", () => {
    const p = base(); const added = dispatchCommand(createCommandHistory(p), { type: "addTrack" })!.history;
    const pending = updateEditorView(undo(added)!, { selectedClipIds: ["stale"] });
    expect(canRedo(pending)).toBe(true); const key = projectContentKey(getCurrentProject(pending));
    expect(dispatchCommand(pending, { type: "addAssetAtPlayhead", assetId: "deleted", clipId: "new" })).toBeNull();
    expect(projectContentKey(getCurrentProject(pending))).toBe(key); expect(canRedo(pending)).toBe(true);
    expect(addAssetAtPlayhead({ ...p, tracks: [] }, video.id, "new")).toBeNull();
    expect(addAssetAtPlayhead({ ...p, clips: [existing("new", 0)] }, video.id, "new")).toBeNull();
    expect(addAssetAtPlayhead({ ...p, playheadSec: NaN }, video.id, "new")).toBeNull();
  });
});
