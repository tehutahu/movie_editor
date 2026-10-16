import { describe, expect, it } from "vitest";
import { createCommandHistory, dispatchCommand, undo, redo, canUndo, canRedo, getCurrentProject, updateEditorView } from "@/lib/editor/commandHistory";
import { createEmptyProject, clipFromAsset } from "@/lib/editor/project";
import type { Asset } from "@/lib/editor/types";

const asset: Asset = {
  id: "a1",
  kind: "video",
  streamUrl: "/x",
  displayName: "v.mp4",
  sourceDurationSec: 10,
  ext: "mp4",
};

describe("commandHistory", () => {
  it("supports undo/redo for delete", () => {
    let project = createEmptyProject();
    const track = project.tracks[0]!;
    const clip = clipFromAsset({ asset, trackId: track.id, timelineStartSec: 0 });
    project = { ...project, assets: [asset], clips: [clip] };
    let history = createCommandHistory(project);

    const del = dispatchCommand(history, { type: "delete", clipIds: [clip.id] });
    expect(del).not.toBeNull();
    history = del!.history;
    expect(history.undoStack[history.undoStack.length - 1]!.clips).toHaveLength(0);

    const undone = undo(history);
    expect(undone).not.toBeNull();
    history = undone!;
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(true);
    expect(history.undoStack[history.undoStack.length - 1]!.clips).toHaveLength(1);

    const redone = redo(history);
    expect(redone).not.toBeNull();
    expect(canRedo(redone!)).toBe(false);
  });
});

describe("navigation after Undo (#21)", () => {
  function editedHistory() {
    const initial = createEmptyProject();
    const clip = clipFromAsset({ asset, trackId: initial.tracks[0]!.id, timelineStartSec: 0 });
    const project = { ...initial, assets: [asset], clips: [clip], selectedClipIds: [clip.id] };
    const history = dispatchCommand(createCommandHistory(project), { type: "split", clipId: clip.id, atSec: 3 })!.history;
    return { history, clip };
  }

  it.each([
    ["seek", { playheadSec: 2 }],
    ["frame step", { playheadSec: 1 / 30 }],
    ["select", { selectedClipIds: ["another-clip"] }],
    ["clear selection", { selectedClipIds: [] }],
  ])("preserves Redo after %s without adding an Undo entry", (_action, view) => {
    const { history } = editedHistory();
    const undone = undo(history)!;
    const before = getCurrentProject(undone);
    const navigated = updateEditorView(undone, view);
    expect(canRedo(navigated)).toBe(true);
    expect(canUndo(navigated)).toBe(false);
    expect(navigated.undoStack).toHaveLength(undone.undoStack.length);
    expect(navigated.redoStack).toBe(undone.redoStack);
    expect(getCurrentProject(navigated)).toEqual({ ...before, ...view });
    expect(getCurrentProject(undone)).toBe(before);
    expect(getCurrentProject(redo(navigated)!)).toEqual(getCurrentProject(history));
  });

  it("preserves the entire Redo chain across repeated navigation", () => {
    const { history } = editedHistory();
    const second = dispatchCommand(history, { type: "addTrack" })!.history;
    const undone = undo(undo(second)!)!;
    let navigated = updateEditorView(undone, { playheadSec: 2 });
    navigated = updateEditorView(navigated, { selectedClipIds: [] });
    navigated = updateEditorView(navigated, { playheadSec: 1 });
    expect(navigated.redoStack).toHaveLength(2);
    const redone = redo(navigated)!;
    expect(getCurrentProject(redone)).toEqual(getCurrentProject(history));
    expect(getCurrentProject(redo(redone)!)).toEqual(getCurrentProject(second));
  });

  it("still invalidates Redo when a new edit follows navigation", () => {
    const { history, clip } = editedHistory();
    const navigated = updateEditorView(undo(history)!, { playheadSec: 2 });
    const edited = dispatchCommand(navigated, { type: "delete", clipIds: [clip.id] })!.history;
    expect(canRedo(edited)).toBe(false);
    expect(getCurrentProject(edited).clips).toHaveLength(0);
    expect(getCurrentProject(undo(edited)!).playheadSec).toBe(2);
  });
});
