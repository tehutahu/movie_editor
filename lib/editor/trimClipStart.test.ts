import { describe, it, expect } from "vitest";
import { createEmptyProject, clipFromAsset } from "./project";
import { trimClipStart, trimStartSnapshot, matchesTrimStartSnapshot, trimStartReason } from "./trimClipStart";
import { applyCommand } from "./commands";
import { createCommandHistory, dispatchCommand, undo, redo, getCurrentProject } from "./commandHistory";
import { projectDocumentDraft, parseProjectDocument, documentToProject } from "./projectDocument";
import type { EditorProject } from "./types";
const assetId = "11111111-1111-4111-8111-111111111111";
function fixture(): EditorProject {
  const p = createEmptyProject();
  p.assets = [{ id: assetId, kind: "video", ext: "mp4", streamUrl: `/api/assets/${assetId}/stream`, displayName: "source", sourceDurationSec: 20 }];
  const c = clipFromAsset({ asset: p.assets[0], trackId: p.tracks[0].id, timelineStartSec: 2, durationSec: 6 });
  c.parts = [{ assetId, sourceInSec: 3, sourceOutSec: 5 }, { assetId, sourceInSec: 9, sourceOutSec: 13 }];
  p.clips = [c]; p.selectedClipIds = [c.id]; p.playheadSec = 4.5; p.compositionDurationSec = 20;
  return p;
}
describe("trim clip prefix at playhead", () => {
  it("consumes timeline offset across parts, keeping old end, identity and unrelated state", () => {
    const p = fixture(), before = structuredClone(p), c = p.clips[0];
    const n = trimClipStart(p, c.id, 4.5)!;
    expect(n.clips[0]).toEqual({ ...c, timelineStartSec: 4.5, durationSec: 3.5, parts: [{ assetId, sourceInSec: 9.5, sourceOutSec: 13 }] });
    expect(n.clips[0].timelineStartSec + n.clips[0].durationSec).toBe(8);
    expect(n.assets).toBe(p.assets); expect(n.tracks).toBe(p.tracks);
    expect(n.compositionDurationSec).toBe(20); expect(n.playheadSec).toBe(4.5); expect(n.selectedClipIds).toBe(p.selectedClipIds);
    expect(p).toEqual(before);
    // Hand oracle: timeline 4.5/5/7.9 maps to source 9.5/10/12.9 before and after.
    for (const [t, source] of [[4.5, 9.5], [5, 10], [7.9, 12.9]])
      expect(n.clips[0].parts[0].sourceInSec + t - n.clips[0].timelineStartSec).toBeCloseTo(source, 12);
  });
  it("allows a .01 prefix and keeps a positive microscopic part without EPS snapping", () => {
    const p = fixture(), id = p.clips[0].id;
    expect(trimClipStart(p, id, 2.01)!.clips[0].parts[0].sourceInSec).toBeCloseTo(3.01, 14);
    const n = trimClipStart(p, id, 4 - 1e-12)!;
    expect(n.clips[0].parts).toHaveLength(2);
    expect(n.clips[0].parts[0].sourceOutSec - n.clips[0].parts[0].sourceInSec).toBeGreaterThan(0);
    expect(trimClipStart(p, id, 4)!.clips[0].parts).toEqual([{ assetId, sourceInSec: 9, sourceOutSec: 13 }]);
    expect(trimClipStart(p, id, 4 + 1e-12)!.clips[0].parts[0].sourceInSec).toBeGreaterThan(9);
  });
  it.each([0, 5e-7, -5e-7, 9.9999999e-7, -9.9999999e-7])("retains legal declared duration drift %s with fixed start/end and valid save", drift => {
    const p = fixture(), c = p.clips[0]; c.durationSec += drift;
    const n = trimClipStart(p, c.id, 4)!;
    expect(n.clips[0].timelineStartSec).toBe(4);
    expect(n.clips[0].durationSec).toBe(c.timelineStartSec + c.durationSec - 4);
    expect(n.clips[0].parts).toEqual([{ assetId, sourceInSec: 9, sourceOutSec: 13 }]);
    expect(documentToProject(parseProjectDocument(projectDocumentDraft(n))).clips).toEqual(n.clips);
  });
  it.each([0, 2, 100, 86390])("canonicalizes only one ULP at MIN boundary near %s", start => {
    const p = fixture(), c = p.clips[0]; c.timelineStartSec = start;
    p.compositionDurationSec = 86400;
    const end = start + c.durationSec, nominal = end - .05;
    const n = trimClipStart(p, c.id, nominal)!.clips[0];
    expect(n.durationSec).toBeGreaterThanOrEqual(.05);
    expect(n.durationSec).toBe(end - n.timelineStartSec);
    expect(n.timelineStartSec + n.durationSec).toBe(end);
    expect(n.timelineStartSec).toBeLessThanOrEqual(nominal);
    expect(nominal - n.timelineStartSec).toBeLessThanOrEqual(Number.EPSILON * Math.max(1, nominal));
    expect(() => parseProjectDocument(projectDocumentDraft({ ...p, clips: [n] }))).not.toThrow();
  });
  it.each([1e-10, 86390])("keeps an atomic positive tail at source %s without extending its bounds", source => {
    const p = fixture(), c = p.clips[0];
    const step = source < 1 ? 1.2924697071141057e-26 : 1.4551915228366852e-11;
    c.timelineStartSec = 0;
    // A .01 prefix makes this a real edit; the next one-ULP part straddles the cut.
    c.parts = [{ assetId, sourceInSec: 0, sourceOutSec: .01 },
      { assetId, sourceInSec: source, sourceOutSec: source + step },
      { assetId, sourceInSec: 1, sourceOutSec: 2 }];
    c.durationSec = c.parts.reduce((sum, part) => sum + part.sourceOutSec - part.sourceInSec, 0);
    // At near-zero the timeline cannot represent a sub-tail increment: exact
    // boundary must preserve that whole following microscopic positive part.
    const request = .01 + step * .75;
    const n = trimClipStart(p, c.id, request)!.clips[0];
    expect(n.parts).toHaveLength(2);
    expect(n.parts[0].sourceInSec).toBe(source);
    expect(n.parts[0].sourceOutSec).toBe(source + step);
    expect(n.parts[0].sourceOutSec - n.parts[0].sourceInSec).toBeGreaterThan(0);
    expect(Math.abs(n.parts.reduce((sum, part) => sum + part.sourceOutSec - part.sourceInSec, 0) - n.durationSec)).toBeLessThanOrEqual(1e-6);
  });
  it("uses equivalent retained duration to avoid a legal drift-boundary cancellation", () => {
    const p = fixture(), c = p.clips[0]; c.durationSec = 1.000001;
    c.parts = [{ assetId, sourceInSec: 0, sourceOutSec: 1 }];
    const n = trimClipStart(p, c.id, 2.01)!.clips[0];
    expect(n.timelineStartSec).toBe(2.01);
    expect(n.durationSec).toBe(c.durationSec - (2.01 - 2));
    expect(n.timelineStartSec + n.durationSec).toBe(c.timelineStartSec + c.durationSec);
    expect(n.parts[0].sourceInSec).toBe(2.01 - 2);
    expect(() => parseProjectDocument(projectDocumentDraft({ ...p, clips: [n] }))).not.toThrow();
  });
  it.each([
    { start: 2, duration: 1.4085342833637948, parts: [[86390, 86391.40853328336]], at: 3.289899763265661, bound: 1.4551915228366852e-11 },
    { start: 0, duration: 8.964379155596776, parts: [[66392.27064826737, 66396.20048881872], [0, 5.034537604242202]], at: 3.929840551354573, bound: 1.7763568394002505e-15 },
    { start: 2, duration: 1.000001, parts: [[86390, 86391]], at: 2.950001, bound: 1.4551915228366852e-11 },
    { start: 86390, duration: 1.000001, parts: [[0, 1]], at: 86390.01, bound: 1.4551915228366852e-11 },
  ])("rescues arithmetic boundary $start/$at within one hand-calculated input ULP", ({ start, duration, parts, at, bound }) => {
    const p = fixture(), c = p.clips[0]; p.assets[0].sourceDurationSec = 86400; p.compositionDurationSec = 86400;
    c.timelineStartSec = start; c.durationSec = duration; c.parts = parts.map(([sourceInSec, sourceOutSec]) => ({ assetId, sourceInSec, sourceOutSec }));
    const n = trimClipStart(p, c.id, at)!.clips[0];
    expect(n.timelineStartSec).toBe(at);
    expect(n.durationSec).toBeGreaterThanOrEqual(.05);
    expect(Math.abs(n.timelineStartSec + n.durationSec - (start + duration))).toBeLessThanOrEqual(bound);
    let prefix = at - start, first = 0;
    while (prefix >= parts[first][1] - parts[first][0]) { prefix -= parts[first][1] - parts[first][0]; first++; }
    const normalIn = parts[first][0] + prefix;
    expect(n.parts[0].sourceInSec).toBeGreaterThanOrEqual(parts[first][0]);
    expect(n.parts[0].sourceInSec).toBeLessThan(parts[first][1]);
    expect(n.parts[0].sourceOutSec).toBe(parts[first][1]);
    expect(Math.abs(n.parts[0].sourceInSec - normalIn)).toBeLessThanOrEqual(bound);
    expect(() => parseProjectDocument(projectDocumentDraft({ ...p, clips: [n] }))).not.toThrow();
  });
  it("retains exact boundaries and existing tolerance across many parts and signed drift", () => {
    for (const start of [0, 2, 86300]) for (const source of [0, 3, 86300]) for (const drift of [0, 5e-7, -5e-7, 1e-6, -1e-6]) {
      const p = fixture(), c = p.clips[0]; p.assets[0].sourceDurationSec = 86400; p.compositionDurationSec = 86400;
      c.timelineStartSec = start;
      c.parts = Array.from({ length: 50 }, (_, i) => ({ assetId, sourceInSec: source + i, sourceOutSec: source + i + .2 }));
      const sum = c.parts.reduce((s, part) => s + part.sourceOutSec - part.sourceInSec, 0);
      c.durationSec = sum + drift;
      if (Math.abs(c.durationSec - sum) > 1e-6) continue; // The input validator rejects this rounded side of the boundary.
      for (const prefix of [.01, c.parts[0].sourceOutSec - source, 3.17, c.durationSec - .05]) {
        const at = start + prefix;
        const n = trimClipStart(p, c.id, at);
        expect(n, JSON.stringify({ start, source, drift, at })).not.toBeNull();
        expect(() => parseProjectDocument(projectDocumentDraft(n!))).not.toThrow();
        expect(Math.abs(n!.clips[0].timelineStartSec + n!.clips[0].durationSec - (start + c.durationSec))).toBeLessThanOrEqual(1.4551915228366852e-11 * 50);
      }
    }
  });
  it("rejects unrepresentable pure-model trim with an explicit reason and intact Redo, preserving the saved-document boundary", () => {
    const p = fixture(), c = p.clips[0];
    c.timelineStartSec = 0; c.durationSec = 32768; c.parts = [{ assetId, sourceInSec: 1e20, sourceOutSec: 1e20 + 32768 }];
    p.assets[0].kind = "image"; p.assets[0].ext = "png"; delete p.assets[0].sourceDurationSec;
    p.compositionDurationSec = 40000; p.playheadSec = 100;
    const doc = projectDocumentDraft(p);
    expect(() => parseProjectDocument(doc)).toThrow("切り出し区間が素材長を超えています。");
    expect(trimClipStart(p, c.id, 100)).toBeNull();
    expect(trimStartReason(p)).toContain("素材の時刻精度");
    const original = structuredClone(p), h = createCommandHistory(p);
    const changed = dispatchCommand(h, { type: "addTrack" })!;
    const pending = undo(changed.history)!;
    expect(dispatchCommand(pending, { type: "trimStart", clipId: c.id, atSec: 100 })).toBeNull();
    expect(pending.redoStack).toHaveLength(1);
    expect(projectDocumentDraft(p)).toEqual(doc); expect(p).toEqual(original);
    expect(redo(pending)!.undoStack).toHaveLength(2);
  });
  it("pure helper clamps but command rejects nonfinite, outside, unknown and non-single selection", () => {
    const p = fixture(), id = p.clips[0].id;
    expect(trimClipStart(p, id, 100)!.clips[0].durationSec).toBeGreaterThanOrEqual(.05);
    for (const atSec of [-1, 1.9, 2, 2 + 1e-10, 7.951, 8, 100, NaN, Infinity, -Infinity])
      expect(applyCommand(p, { type: "trimStart", clipId: id, atSec })).toBeNull();
    expect(trimClipStart(p, "missing", 4)).toBeNull();
    expect(applyCommand({ ...p, selectedClipIds: [] }, { type: "trimStart", clipId: id, atSec: 4 })).toBeNull();
    expect(applyCommand({ ...p, selectedClipIds: [id, "other"] }, { type: "trimStart", clipId: id, atSec: 4 })).toBeNull();
  });
  it("records one edit with Undo/Redo, invalid and no-op preserve pending Redo", () => {
    const p = fixture(), h = createCommandHistory(p), id = p.clips[0].id;
    const result = dispatchCommand(h, { type: "trimStart", clipId: id, atSec: 4 })!;
    expect(result.history.undoStack).toHaveLength(2);
    const undone = undo(result.history)!; expect(getCurrentProject(undone)).toBe(p);
    expect(dispatchCommand(undone, { type: "trimStart", clipId: id, atSec: -1 })).toBeNull();
    expect(dispatchCommand(undone, { type: "trimStart", clipId: id, atSec: 2 })).toBeNull();
    expect(getCurrentProject(redo(undone)!)).toEqual(result.project);
  });
  it("snapshot allows latest playhead, rejects stale selection/epoch/source/geometry", () => {
    const p = fixture(), s = trimStartSnapshot(p, 3)!;
    expect(matchesTrimStartSnapshot({ ...p, playheadSec: 6 }, 3, s)).toBe(true);
    expect(matchesTrimStartSnapshot(p, 4, s)).toBe(false);
    expect(matchesTrimStartSnapshot({ ...p, selectedClipIds: [] }, 3, s)).toBe(false);
    for (const patch of [{ sourceJobId: assetId }, { storageAssetId: assetId }, { streamUrl: "changed" }, { sourceDurationSec: 99 }])
      expect(matchesTrimStartSnapshot({ ...p, assets: [{ ...p.assets[0], ...patch }] }, 3, s)).toBe(false);
    for (const patch of [{ timelineStartSec: 3 }, { durationSec: 3 }, { trackId: "other" }, { parts: [] }])
      expect(matchesTrimStartSnapshot({ ...p, clips: [{ ...p.clips[0], ...patch }] }, 3, s)).toBe(false);
  });
  it.each(["stretch", "contain"] as const)("preserves %s, image and restored current-source references", mode => {
    const p = fixture(); p.assets[0] = { ...p.assets[0], kind: "image", ext: "png", sourceJobId: assetId };
    p.clips[0].layoutMode = mode; p.clips[0].transform = { x: .3, y: .7, scale: .6 };
    const n = trimClipStart(p, p.clips[0].id, 3)!;
    expect(n.assets).toBe(p.assets); expect(n.clips[0].layoutMode).toBe(mode);
    expect(n.clips[0].transform).toBe(p.clips[0].transform);
    expect(n.clips[0].parts[0]).toEqual({ assetId, sourceInSec: 4, sourceOutSec: 5 });
  });
});
