import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applySpeedRestoreToProject } from "./applySpeedRestore";
import { createEmptyProject, clipFromAsset } from "./project";
import { parseProjectDocument, projectDocumentDraft, documentToProject } from "./projectDocument";
import { parseClip } from "./validateExportProject";
import { createCommandHistory, dispatchCommand, getCurrentProject, undo, redo } from "./commandHistory";
import type { Asset, EditorProject } from "./types";
function fixture(kind: "video" | "image" = "video", repeated = false) {
  const p = createEmptyProject();
  const a: Asset = { id: randomUUID(), kind: "video", ext: "mp4", streamUrl: "/a", displayName: "A", sourceDurationSec: 10, width: 320, height: 240 };
  const b: Asset = { ...a, id: randomUUID(), kind, ext: kind === "video" ? "mp4" : "png", streamUrl: "/b", displayName: "B" };
  p.assets = [a, b];
  const c = clipFromAsset({ asset: a, trackId: p.tracks[0].id, timelineStartSec: 1 });
  c.parts = [{ assetId: a.id, sourceInSec: 1, sourceOutSec: 2 }, { assetId: b.id, sourceInSec: .5, sourceOutSec: 1.5 }];
  if (repeated) c.parts!.push({ assetId: a.id, sourceInSec: 3, sourceOutSec: 4 });
  c.durationSec = repeated ? 3 : 2; c.layoutMode = "contain"; c.transform = { x: .25, y: .6, scale: .8 };
  p.clips = [c, { ...structuredClone(c), id: randomUUID(), timelineStartSec: 6 }, clipFromAsset({ asset: b, trackId: p.tracks[1].id, timelineStartSec: 12 })];
  p.compositionDurationSec = 30; p.compositionWidth = 640; p.compositionHeight = 360;
  p.selectedClipIds = [c.id]; return p;
}
function params(p: EditorProject, factor: number) {
  return { assetId: p.assets[0].id, jobId: randomUUID(), speedFactor: factor, restoredDurationSec: 10 * factor, restoredWidth: 320, restoredHeight: 240 };
}
function sum(p: EditorProject, i = 0) { return p.clips[i].parts!.reduce((s, part) => s + part.sourceOutSec - part.sourceInSec, 0); }
function validate(p: EditorProject) {
  const doc = parseProjectDocument(projectDocumentDraft(p));
  expect(documentToProject(doc).clips).toEqual(p.clips);
  p.clips.forEach((clip, i) => expect(parseClip(clip, i, new Set(p.tracks.map(t => t.id)), new Set(p.assets.map(a => a.id)), p.compositionDurationSec)).toEqual(clip));
}
describe("mixed asset restore duration", () => {
  it.each(["video", "image"] as const)("changes only A ranges and affected duration in A/B(%s)/A, all uses; one Undo/Redo", kind => {
    for (const factor of [2, .5, 1]) {
      const p = fixture(kind, true), before = structuredClone(p), command = { type: "restoreSpeed" as const, ...params(p, factor) };
      const result = dispatchCommand(createCommandHistory(p), command)!; const n = result.project;
      expect(result.history.undoStack).toHaveLength(2); expect(result.history.redoStack).toEqual([]);
      for (let i = 0; i < 2; i++) {
        const c = n.clips[i], old = p.clips[i]; expect(c.durationSec).toBe(1 + 2 * factor); expect(sum(n, i)).toBe(c.durationSec);
        expect(c.parts![1]).toEqual(old.parts![1]);
        for (const j of [0, 2]) expect(c.parts![j]).toEqual({ ...old.parts![j], sourceInSec: old.parts![j].sourceInSec * factor, sourceOutSec: old.parts![j].sourceOutSec * factor });
        expect({ ...c, parts: old.parts!, durationSec: old.durationSec }).toEqual(old);
      }
      expect(n.clips[2]).toEqual(p.clips[2]); expect(n.assets[1]).toEqual(p.assets[1]);
      expect(n).toMatchObject({ compositionWidth: 640, compositionHeight: 360, selectedClipIds: p.selectedClipIds });
      validate(n); expect(p).toEqual(before);
      const h = undo(result.history)!; expect(getCurrentProject(h)).toEqual(p); expect(getCurrentProject(redo(h)!)).toEqual(n);
    }
  });
  it.each([-1e-6, -5e-7, 0, 5e-7, 1e-6])("preserves legal mixed drift %s without amplification", drift => {
    const p = fixture(); p.clips = [p.clips[0]]; p.clips[0].durationSec = 2 + drift;
    // Decimal endpoint drift at tolerance is determined by the existing validator, not an assumed real-number boundary.
    if (Math.abs(sum(p) - p.clips[0].durationSec) > 1e-6) p.clips[0].durationSec = 2 + drift * .999999999;
    for (const factor of [2, .5, 1]) {
      const n = applySpeedRestoreToProject(p, params(p, factor));
      expect(Math.abs(sum(n) - n.clips[0].durationSec)).toBeLessThanOrEqual(1e-6);
      expect((n.clips[0].durationSec - sum(n)) - (p.clips[0].durationSec - sum(p))).toBeCloseTo(0, 14);
      validate(n);
      if (factor === 1) expect(n.clips[0].durationSec).toBe(p.clips[0].durationSec);
    }
  });
  it("keeps the valid all-target legacy result and only falls back when scaling drift would invalidate it", () => {
    for (const drift of [0, 2e-7, 8e-7]) {
      const p = fixture(); p.clips = [p.clips[0]]; p.clips[0].parts![1].assetId = p.assets[0].id; p.clips[0].durationSec = 2 + drift;
      const n = applySpeedRestoreToProject(p, params(p, 2)); const legacy = p.clips[0].durationSec * 2;
      if (Math.abs(sum(n) - legacy) <= 1e-6) expect(n.clips[0].durationSec).toBe(legacy);
      else expect(n.clips[0].durationSec - sum(n)).toBeCloseTo(p.clips[0].durationSec - sum(p), 14);
      validate(n);
    }
  });
  it("keeps signed legal drift consistent across the maximum 50 mixed parts", () => {
    for (const drift of [-9.99e-7, 0, 9.99e-7]) for (const factor of [2, .5, 1]) {
      const p = fixture(); p.clips = [p.clips[0]];
      p.clips[0].parts = Array.from({ length: 50 }, (_, i) => ({ assetId: p.assets[i % 2].id, sourceInSec: i * .1, sourceOutSec: i * .1 + .05 }));
      p.clips[0].durationSec = sum(p) + drift; validate(p);
      const n = applySpeedRestoreToProject(p, params(p, factor)); validate(n);
      const intended = p.clips[0].durationSec + (sum(n) - sum(p));
      expect(Math.abs(n.clips[0].durationSec - intended)).toBeLessThanOrEqual(1e-9);
      expect(n.clips[0].parts!).toHaveLength(50);
      p.clips[0].parts!.forEach((part, i) => { if (i % 2) expect(n.clips[0].parts![i]).toEqual(part); });
    }
  });
  it("accepts MIN exactly without inventing source material", () => {
    const p = fixture(); p.clips = [p.clips[0]]; p.clips[0].parts = [{ assetId: p.assets[0].id, sourceInSec: 0, sourceOutSec: .1 }]; p.clips[0].durationSec = .1;
    const n = applySpeedRestoreToProject(p, params(p, .5)); expect(n.clips[0].durationSec).toBe(.05); expect(n.clips[0].parts![0].sourceOutSec).toBe(.05); validate(n);
  });
  it("does not clamp a genuinely below-MIN adjacent duration", () => {
    const p = fixture(); p.clips = [p.clips[0]]; p.clips[0].parts = [{ assetId: p.assets[0].id, sourceInSec: 0, sourceOutSec: .09999999999999999 }]; p.clips[0].durationSec = .09999999999999999;
    expect(() => applySpeedRestoreToProject(p, params(p, .5))).toThrow(/短すぎ/);
  });
  it("handles ordinary large source offsets without altering the unrelated part", () => {
    const p = fixture(); p.assets[0].sourceDurationSec = 86400; p.clips = [p.clips[0]];
    p.clips[0].parts![0].sourceInSec = 86390.1; p.clips[0].parts![0].sourceOutSec = 86391.1;
    const n = applySpeedRestoreToProject(p, { ...params(p, .5), restoredDurationSec: 43200 });
    expect(n.clips[0].parts![1]).toEqual(p.clips[0].parts![1]); expect(Math.abs(sum(n) - n.clips[0].durationSec)).toBeLessThanOrEqual(1e-6); validate(n);
  });
  it.each(["MIN", "overflow", "collapsed", "out-of-bounds", "invalid-drift"])("rejects %s atomically, retaining original history and Redo", reason => {
    const p = fixture(); p.clips = [p.clips[0]]; const command = { type: "restoreSpeed" as const, ...params(p, .5) };
    if (reason === "MIN") { p.clips[0].parts = [{ assetId: p.assets[0].id, sourceInSec: 0, sourceOutSec: .05 }]; p.clips[0].durationSec = .05; }
    if (reason === "overflow") command.speedFactor = 1e308;
    if (reason === "collapsed") { p.clips[0].parts![0].sourceInSec = Number.MIN_VALUE; p.clips[0].parts![0].sourceOutSec = 2 * Number.MIN_VALUE; command.speedFactor = Number.MIN_VALUE; }
    if (reason === "out-of-bounds") command.restoredDurationSec = .1;
    if (reason === "invalid-drift") p.clips[0].durationSec += .01;
    const history = undo(dispatchCommand(createCommandHistory(p), { type: "addTrack" })!.history)!; const before = structuredClone(history);
    expect(() => dispatchCommand(history, command)).toThrow(); expect(history).toEqual(before); expect(getCurrentProject(history)).toEqual(p);
  });
});
