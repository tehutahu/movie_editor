import { describe, expect, it } from "vitest";
import { createCommandHistory, dispatchCommand, undo, redo, canUndo, canRedo } from "@/lib/editor/commandHistory";
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
