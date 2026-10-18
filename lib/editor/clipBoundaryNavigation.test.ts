import { describe, expect, it } from "vitest";
import { applyClipBoundaryNavigation, clipBoundaryTarget } from "./clipBoundaryNavigation";
import { createCommandHistory, dispatchCommand, getCurrentProject, undo, updateEditorView } from "./commandHistory";
import { createEmptyProject } from "./project";
import { projectContentKey, projectDocumentDraft } from "./projectDocument";
import type { Clip, EditorProject, MediaClip } from "./types";

const media = (start: number, duration: number, id = "video"): MediaClip => ({
  id, trackId: "T1", timelineStartSec: start, durationSec: duration,
  transform: { x: .5, y: .5, scale: 1 }, parts: [{ assetId: "asset", sourceInSec: 2, sourceOutSec: 2 + duration }],
});
const project = (clips: Clip[], playheadSec = 0, compositionDurationSec = 30): EditorProject => ({
  ...createEmptyProject(), clips, playheadSec, compositionDurationSec,
});

describe("strict outer clip boundary navigation", () => {
  it("finds the nearest strict neighbor across unsorted overlapping tracks and title clips", () => {
    const title: Clip = { id: "title", kind: "title", trackId: "T2", timelineStartSec: 3.7, durationSec: 4.55,
      transform: { x: .5, y: .5, scale: 1 }, text: "章題", fontId: "fixed", fontRevision: "1", styleRevision: "1" };
    const p = project([media(8.25, 3.75), title, media(0, 3.7)], 4, 12);
    expect(clipBoundaryTarget(p, "previous")).toBe(3.7);
    expect(clipBoundaryTarget(p, "next")).toBe(8.25);
    p.playheadSec = 3.7;
    expect(clipBoundaryTarget(p, "previous")).toBe(0);
    expect(clipBoundaryTarget(p, "next")).toBe(8.25);
    expect(clipBoundaryTarget({ ...p, clips: [...p.clips].reverse() }, "next")).toBe(8.25);
  });
  it("does not introduce composition sentinels or multipart interior endpoints", () => {
    const clip = media(4, 4); clip.parts = [{ assetId: "a", sourceInSec: 0, sourceOutSec: 2 }, { assetId: "b", sourceInSec: 5, sourceOutSec: 7 }];
    expect(clipBoundaryTarget(project([clip], 6), "previous")).toBe(4);
    expect(clipBoundaryTarget(project([clip], 6), "next")).toBe(8);
    expect(clipBoundaryTarget(project([clip], 3), "previous")).toBeUndefined();
    expect(clipBoundaryTarget(project([clip], 9), "next")).toBeUndefined();
    expect(clipBoundaryTarget(project([], 5), "next")).toBeUndefined();
  });
  it("filters endpoints independently without clamping out-of-domain starts or ends", () => {
    const p = project([media(-2, 5), media(8, 5)], 5, 10);
    expect(clipBoundaryTarget(p, "previous")).toBe(3);
    expect(clipBoundaryTarget(p, "next")).toBe(8);
    expect(clipBoundaryTarget({ ...p, playheadSec: 9 }, "next")).toBeUndefined();
    expect(clipBoundaryTarget(project([media(Number.MAX_VALUE, Number.MAX_VALUE)], 0, Number.MAX_VALUE), "next")).toBe(Number.MAX_VALUE);
  });
  it.each([NaN, Infinity, -Infinity, -1])("rejects invalid project clock %s without fabricating a boundary", invalid => {
    expect(clipBoundaryTarget(project([media(0, 2)], invalid), "next")).toBeUndefined();
    expect(clipBoundaryTarget(project([media(0, 2)], 0, invalid), "next")).toBeUndefined();
  });
  it("rejects past-composition playheads and invalid clip start/duration but keeps valid clips", () => {
    expect(clipBoundaryTarget(project([media(0, 2)], 31), "previous")).toBeUndefined();
    const bad = [media(NaN, 1), media(Infinity, 1), media(1, NaN), media(1, Infinity), media(1, 0), media(1, -2)];
    expect(clipBoundaryTarget(project(bad, 0), "next")).toBeUndefined();
    expect(clipBoundaryTarget(project([...bad, media(4, 1)], 0), "next")).toBe(4);
  });
  it("distinguishes adjacent doubles and retains binary64 addition instead of displayed decimals", () => {
    const p = project([media(0, .3), media(.30000000000000004, 1)], .3);
    expect(clipBoundaryTarget(p, "next")).toBe(.30000000000000004);
    expect(clipBoundaryTarget({ ...p, playheadSec: .30000000000000004 }, "previous")).toBe(.3);
    expect(clipBoundaryTarget(project([media(.1, .2)], .3), "next")).toBe(.30000000000000004);
    expect(clipBoundaryTarget(project([media(86399.99999999999, .00000000001)], 86400, 86400), "previous")).toBe(86399.99999999999);
  });
  it("deduplicates exact shared endpoints and normalizes negative zero only", () => {
    const p = project([media(-0, 1), media(0, 1), media(1, 1)], 1);
    expect(Object.is(clipBoundaryTarget(p, "previous"), 0)).toBe(true);
    expect(clipBoundaryTarget(p, "next")).toBe(2);
    expect(clipBoundaryTarget({ ...p, playheadSec: 0 }, "previous")).toBeUndefined();
  });
});

describe("adopted boundary view updates", () => {
  it("advances twice from adopted positions, and recomputes against intervening edits", () => {
    const initial = createCommandHistory(project([media(0, 3), media(5, 2)], 1));
    const first = applyClipBoundaryNavigation(initial, "next", 4, 4, false);
    const second = applyClipBoundaryNavigation(first, "next", 4, 4, false);
    expect(getCurrentProject(first).playheadSec).toBe(3);
    expect(getCurrentProject(second).playheadSec).toBe(5);
    const changed = createCommandHistory(project([media(0, 2)], 1));
    expect(getCurrentProject(applyClipBoundaryNavigation(changed, "next", 4, 4, false)).playheadSec).toBe(2);
    const advanced = updateEditorView(initial, { playheadSec: 6 });
    expect(getCurrentProject(applyClipBoundaryNavigation(advanced, "next", 4, 4, false)).playheadSec).toBe(7);
  });
  it("rejects queued epoch/blocked/no-target without allocating history or changing Redo", () => {
    const initial = createCommandHistory(project([media(4, 2)], 1));
    expect(applyClipBoundaryNavigation(initial, "next", 4, 5, false)).toBe(initial);
    expect(applyClipBoundaryNavigation(initial, "next", 4, 4, true)).toBe(initial);
    expect(applyClipBoundaryNavigation(initial, "previous", 4, 4, false)).toBe(initial);
  });
  it("preserves selection, document, dirty key, fade anchor and both history depths even for sub-microsecond jumps", () => {
    const clip = media(.30000000000000004, 2);
    clip.audioGain = .4; clip.audioFade = { inSec: 1, outSec: 0, anchorDurationSec: 4, offsetSec: .5 };
    const p = project([clip], .3); p.selectedClipIds = [clip.id];
    p.assets = [{ id: "asset", kind: "video", streamUrl: "/asset", displayName: "元動画", ext: "mp4" }];
    const pending = undo(dispatchCommand(createCommandHistory(p), { type: "addTrack" })!.history)!;
    const before = getCurrentProject(pending), key = projectContentKey(before), dto = projectDocumentDraft(before);
    const after = applyClipBoundaryNavigation(pending, "next", 4, 4, false), current = getCurrentProject(after);
    expect(current.playheadSec).toBe(.30000000000000004);
    expect(current).toEqual({ ...before, playheadSec: .30000000000000004 });
    expect(current.clips).toBe(before.clips); expect(current.assets).toBe(before.assets); expect(current.tracks).toBe(before.tracks);
    expect(current.selectedClipIds).toBe(before.selectedClipIds);
    expect(after.redoStack).toBe(pending.redoStack); expect(after.undoStack).toHaveLength(pending.undoStack.length);
    expect(projectContentKey(current)).toBe(key); expect(projectDocumentDraft(current)).toEqual(dto);
  });
});
