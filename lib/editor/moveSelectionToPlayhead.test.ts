import { describe, expect, it } from "vitest";
import { applyMoveSelectionToPlayhead, matchesMoveToPlayheadSnapshot, moveToPlayheadSnapshot, planMoveSelectionToPlayhead } from "./moveSelectionToPlayhead";
import { createCommandHistory, dispatchCommand, getCurrentProject, redo, undo, updateEditorView } from "./commandHistory";
import { createEmptyProject } from "./project";
import { documentToProject, parseProjectDocument, projectDocumentDraft } from "./projectDocument";
import { titleDescriptor } from "./title";
import type { EditorProject, MediaClip } from "./types";

function fixture(): EditorProject {
  const p = createEmptyProject();
  p.tracks = [0, 1, 2].map(order => ({ id: `T${order}`, order }));
  p.assets = [
    { id: "video", kind: "video", displayName: "元動画", ext: "mp4", streamUrl: "/video", sourceDurationSec: 4, width: 320, height: 180 },
    { id: "image", kind: "image", displayName: "画像", ext: "png", streamUrl: "/image", width: 320, height: 180 },
  ];
  const media = (id: string, track: number, start: number, assetId = "video"): MediaClip => ({
    id, trackId: `T${track}`, timelineStartSec: start, durationSec: .25,
    parts: [{ assetId, sourceInSec: 0, sourceOutSec: .25 }], transform: { x: .5, y: .5, scale: 1 },
  });
  p.clips = [
    { ...media("A", 0, .25), durationSec: .5, parts: [{ assetId: "video", sourceInSec: .5, sourceOutSec: 1 }],
      layoutMode: "contain", audioGain: .7, audioFade: { inSec: 1, outSec: .5, anchorDurationSec: 2, offsetSec: .5 } },
    { id: "B", kind: "title", trackId: "T1", timelineStartSec: .75, durationSec: .25,
      transform: { x: .4, y: .6, scale: 1 }, ...titleDescriptor("章題") },
    media("C", 2, 1.25, "image"), media("other", 0, 4),
  ];
  p.compositionDurationSec = 5; p.playheadSec = 1; p.selectedClipIds = ["C", "A", "B"];
  return p;
}
function apply(p: EditorProject) {
  const h = createCommandHistory(p);
  return applyMoveSelectionToPlayhead(h, moveToPlayheadSnapshot(h, 3), 3, false, false);
}

describe("explicit group placement", () => {
  it("uses the earliest start, preserves every non-time field and all unselected identities", () => {
    const p = fixture(), before = structuredClone(p), h = apply(p), moved = getCurrentProject(h);
    expect(moved.clips.map(c => c.timelineStartSec)).toEqual([1, 1.5, 2, 4]);
    moved.clips.forEach((c, i) => expect({ ...c, timelineStartSec: p.clips[i].timelineStartSec }).toEqual(p.clips[i]));
    expect(moved.clips[3]).toBe(p.clips[3]); expect(moved.assets).toBe(p.assets); expect(moved.tracks).toBe(p.tracks);
    expect(moved.selectedClipIds).toBe(p.selectedClipIds); expect(moved.playheadSec).toBe(1);
    expect(p).toEqual(before); expect(h.undoStack).toHaveLength(2);
    expect(getCurrentProject(undo(h)!)).toBe(p); expect(getCurrentProject(redo(undo(h)!)!)).toBe(moved);
  });
  it("moves left to zero without individual clamps and preserves the composition duration", () => {
    const p = fixture(); p.playheadSec = 0;
    const moved = getCurrentProject(apply(p));
    expect(moved.clips.map(c => c.timelineStartSec)).toEqual([0, .5, 1, 4]);
    expect(moved.compositionDurationSec).toBe(5);
  });
  it("extends only the necessary right extent and clears Redo in exactly one edit", () => {
    const p = fixture(); p.playheadSec = 5;
    const pending = undo(dispatchCommand(createCommandHistory(p), { type: "addTrack" })!.history)!;
    const next = applyMoveSelectionToPlayhead(pending, moveToPlayheadSnapshot(pending, 3), 3, false, false);
    expect(next.undoStack).toHaveLength(pending.undoStack.length + 1); expect(next.redoStack).toEqual([]);
    expect(getCurrentProject(next).compositionDurationSec).toBe(6.25);
  });
  it("rejects the whole group when only one destination collides, and permits exact touching", () => {
    const p = fixture(); p.clips.push({ ...(p.clips[2] as MediaClip), id: "blocker", timelineStartSec: 2.125 });
    const h = createCommandHistory(p);
    expect(planMoveSelectionToPlayhead(p).reason).toMatch(/重なる/);
    expect(applyMoveSelectionToPlayhead(h, moveToPlayheadSnapshot(h, 3), 3, false, false)).toBe(h);
    p.clips[4] = { ...p.clips[4], timelineStartSec: 2.25 };
    expect(getCurrentProject(apply(p)).clips.slice(0, 3).map(c => c.timelineStartSec)).toEqual([1, 1.5, 2]);
  });
  it("retains preexisting selected overlap and ignores cross-track external overlap", () => {
    const p = fixture(); p.clips[2] = { ...p.clips[2], trackId: "T0", timelineStartSec: .5 };
    p.clips[3] = { ...p.clips[3], trackId: "T2", timelineStartSec: 1.1 };
    expect(planMoveSelectionToPlayhead(p).reason).toBeNull();
    expect(getCurrentProject(apply(p)).clips.slice(0, 3).map(c => c.timelineStartSec)).toEqual([1, 1.5, 1.25]);
  });
  it.each([[], ["A"], ["A", "A"], ["A", "missing"]])("rejects invalid selected IDs %j", (...ids) => {
    const p = fixture(); p.selectedClipIds = ids as string[];
    const h = createCommandHistory(p);
    expect(applyMoveSelectionToPlayhead(h, moveToPlayheadSnapshot(h, 3), 3, false, false)).toBe(h);
  });
  it.each([NaN, Infinity, -Infinity, -1, 5.0000001])("rejects invalid target %s", target => {
    const p = fixture(); p.playheadSec = target; expect(planMoveSelectionToPlayhead(p).reason).not.toBeNull();
  });
  it("keeps pending Redo and history identity for exact zero and unrepresentable input displacement", () => {
    const p = fixture(); p.playheadSec = .25 + Number.MIN_VALUE;
    const pending = undo(dispatchCommand(createCommandHistory(p), { type: "addTrack" })!.history)!;
    expect(applyMoveSelectionToPlayhead(pending, moveToPlayheadSnapshot(pending, 3), 3, false, false)).toBe(pending);
    expect(pending.redoStack).toHaveLength(1);
  });
  it("does not discard a representable sub-nanosecond movement", () => {
    const p = fixture(); p.playheadSec = .25000000000000006;
    const next = getCurrentProject(apply(p));
    expect(next.clips[0].timelineStartSec).toBe(.25000000000000006);
    expect(next.clips[0].timelineStartSec).not.toBe(p.clips[0].timelineStartSec);
    expect(next.clips[1].timelineStartSec).toBe(.75 + (p.playheadSec - .25));
  });
  it("bounds cancellation error and refuses a right edge beyond24h", () => {
    const p = fixture(); p.selectedClipIds = ["A", "C"]; p.clips = [p.clips[0], p.clips[2]];
    p.clips[0] = { ...p.clips[0], timelineStartSec: 10000 }; p.clips[1] = { ...p.clips[1], timelineStartSec: 10001 };
    p.compositionDurationSec = 86400; p.playheadSec = .1;
    const moved = getCurrentProject(apply(p)); expect(Math.abs(moved.clips[0].timelineStartSec - .1)).toBeLessThanOrEqual(1e-9);
    p.clips[0] = { ...p.clips[0], timelineStartSec: 86399 }; p.clips[1] = { ...p.clips[1], timelineStartSec: 86399.5 };
    p.playheadSec = 86399.25; expect(planMoveSelectionToPlayhead(p).reason).toBeNull();
    p.playheadSec = 86400; expect(planMoveSelectionToPlayhead(p).reason).not.toBeNull();
  });
});

describe("click snapshot adoption", () => {
  it("rejects epoch, blocked, active capture and even tiny intervening playhead progress", () => {
    const h = createCommandHistory(fixture()), snapshot = moveToPlayheadSnapshot(h, 3);
    expect(applyMoveSelectionToPlayhead(h, snapshot, 4, false, false)).toBe(h);
    expect(applyMoveSelectionToPlayhead(h, snapshot, 3, true, false)).toBe(h);
    expect(applyMoveSelectionToPlayhead(h, snapshot, 3, false, true)).toBe(h);
    const advanced = updateEditorView(h, { playheadSec: 1 + Number.EPSILON });
    expect(applyMoveSelectionToPlayhead(advanced, snapshot, 3, false, false)).toBe(advanced);
  });
  it("rejects selected-set and persistent-reference/geometry/source changes", () => {
    const p = fixture(), h = createCommandHistory(p), snapshot = moveToPlayheadSnapshot(h, 3);
    const variants: EditorProject[] = [{ ...p, selectedClipIds: ["A", "C"] }, { ...p, clips: [...p.clips] },
      { ...p, assets: [...p.assets] }, { ...p, tracks: [...p.tracks] }, { ...p, compositionWidth: 320 },
      { ...p, compositionDurationSec: 6 }, { ...p, exportBaseName: "changed" }];
    for (const current of variants) { const newer = { ...h, undoStack: [current] };
      expect(applyMoveSelectionToPlayhead(newer, snapshot, 3, false, false)).toBe(newer); }
  });
  it("allows view-only selection reordering and carries its latest order into the result", () => {
    const h = createCommandHistory(fixture()), snapshot = moveToPlayheadSnapshot(h, 3);
    const reordered = updateEditorView(h, { selectedClipIds: ["B", "A", "C"] });
    expect(matchesMoveToPlayheadSnapshot(reordered, 3, snapshot)).toBe(true);
    expect(getCurrentProject(applyMoveSelectionToPlayhead(reordered, snapshot, 3, false, false)).selectedClipIds).toEqual(["B", "A", "C"]);
    expect(snapshot).not.toHaveProperty("zoom");
  });
  it("rejects a duplicate snapshot even if a queued view change makes its selection valid", () => {
    const p = fixture(); p.selectedClipIds = ["A", "A"];
    const h = createCommandHistory(p), snapshot = moveToPlayheadSnapshot(h, 3);
    const validNow = updateEditorView(h, { selectedClipIds: ["A", "B"] });
    expect(matchesMoveToPlayheadSnapshot(validNow, 3, snapshot)).toBe(false);
    expect(applyMoveSelectionToPlayhead(validNow, snapshot, 3, false, false)).toBe(validNow);
    const duplicateNow = updateEditorView(validNow, { selectedClipIds: ["A", "A"] });
    expect(applyMoveSelectionToPlayhead(duplicateNow, moveToPlayheadSnapshot(validNow, 3), 3, false, false)).toBe(duplicateNow);
  });
  it("rejects intervening history navigation even when it restores the identical project references", () => {
    const h = dispatchCommand(createCommandHistory(fixture()), { type: "addTrack" })!.history;
    const snapshot = moveToPlayheadSnapshot(h, 3), restored = redo(undo(h)!)!;
    expect(getCurrentProject(restored)).toBe(getCurrentProject(h));
    expect(applyMoveSelectionToPlayhead(restored, snapshot, 3, false, false)).toBe(restored);
  });
});

it.each([1, 2, 3, 4, 5])("retains the minimal save version and source fields through v%s roundtrip", version => {
  const p = fixture();
  if (version < 4) { p.clips = p.clips.filter(c => c.kind !== "title"); p.selectedClipIds = ["A", "C"]; }
  p.clips = p.clips.map(c => {
    if (c.kind === "title") return c;
    const { layoutMode: _layout, audioGain: _gain, audioFade: _fade, ...plain } = c;
    return { ...plain, ...(version === 2 ? { layoutMode: "contain" as const } : {}),
      ...(version === 3 ? { audioGain: .7 } : {}), ...(version === 5 && c.id === "A" ? { audioFade: c.audioFade } : {}) };
  });
  // Saved documents require UUIDs even though the pure move planner accepts
  // readable runtime IDs. Keep all linked references valid for this roundtrip.
  const ids = new Map(["T0", "T1", "T2", "video", "image", "A", "B", "C", "other"]
    .map((id, index) => [id, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`]));
  const uuid = (id: string) => ids.get(id)!;
  p.tracks = p.tracks.map(track => ({ ...track, id: uuid(track.id) }));
  p.assets = p.assets.map(asset => ({ ...asset, id: uuid(asset.id) }));
  p.clips = p.clips.map(clip => clip.kind === "title" ? { ...clip, id: uuid(clip.id), trackId: uuid(clip.trackId) }
    : { ...clip, id: uuid(clip.id), trackId: uuid(clip.trackId), parts: clip.parts.map(part => ({ ...part, assetId: uuid(part.assetId) })) });
  p.selectedClipIds = p.selectedClipIds.map(uuid);
  const before = projectDocumentDraft(p); expect(before.version).toBe(version);
  const restored = documentToProject(parseProjectDocument(before)); restored.selectedClipIds = p.selectedClipIds; restored.playheadSec = 1;
  const moved = getCurrentProject(apply(restored)), after = parseProjectDocument(projectDocumentDraft(moved));
  expect(after.version).toBe(version);
  after.project.clips.forEach((clip, index) => expect({ ...clip, timelineStartSec: before.project.clips[index].timelineStartSec }).toEqual(before.project.clips[index]));
  expect(after.project.assets).toEqual(before.project.assets);
});
