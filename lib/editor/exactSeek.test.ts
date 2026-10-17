import { describe, expect, it } from "vitest";
import { formatExactSeek, parseExactSeek, SEEK_FORMAT_ERROR, SEEK_RANGE_ERROR } from "./exactSeek";
import { createCommandHistory, dispatchCommand, getCurrentProject, undo, updateEditorView } from "./commandHistory";
import { createEmptyProject } from "./project";

describe("exact playhead input", () => {
  it.each([["0", 0], ["1.25", 1.25], ["1:30.250", 90.25], ["120:00", 7200], [" 0001:02.000001 ", 62.000001], ["0.000001", 0.000001]])("accepts %s without frame rounding", (text, value) => {
    expect(parseExactSeek(String(text), 7200)).toEqual({ value });
  });
  it.each(["", " ", "-1", "+1", "1e2", "Infinity", "NaN", "1,2", "1:60", "1:5", "1.", ".5", "1:00:00", "1.0000001", "１", "1 2", "1\n2", "0".repeat(25)])("rejects ambiguous or non-ASCII input %s", text => {
    expect(parseExactSeek(text, 100)).toEqual({ error: SEEK_FORMAT_ERROR });
  });
  it("validates the latest inclusive boundary without clamping", () => {
    expect(parseExactSeek("2", 2)).toEqual({ value: 2 });
    expect(parseExactSeek("2.000001", 2)).toEqual({ error: SEEK_RANGE_ERROR });
    expect(parseExactSeek("2", 1)).toEqual({ error: SEEK_RANGE_ERROR });
    expect(parseExactSeek("0", NaN)).toEqual({ error: SEEK_RANGE_ERROR });
    expect(parseExactSeek("999999999999999999999999", 100)).toEqual({ error: SEEK_RANGE_ERROR });
  });
  it("formats only for presentation, including a nondecimal frame position", () => {
    expect(formatExactSeek(1 / 30)).toBe("0.033333");
    expect(formatExactSeek(90.25)).toBe("90.25");
  });
  it("view-only exact seek retains pending Redo, content and selection", () => {
    const initial = createCommandHistory(createEmptyProject());
    const changed = dispatchCommand(initial, { type: "addTrack" })!.history;
    const pending = undo(changed)!;
    const before = getCurrentProject(pending);
    const after = updateEditorView(pending, { playheadSec: 0.000001 });
    expect(after.redoStack).toBe(pending.redoStack);
    expect(after.undoStack).toHaveLength(pending.undoStack.length);
    expect(getCurrentProject(after)).toEqual({ ...before, playheadSec: 0.000001 });
  });
});
