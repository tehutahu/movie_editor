import { describe, it, expect } from "vitest";
import { createEmptyProject, clipFromAsset } from "./project";
import { trimClipEnd, trimEndReason, trimEndSnapshot, matchesTrimEndSnapshot } from "./trimClipEnd";
import { applyCommand } from "./commands";
import { createCommandHistory, dispatchCommand, undo, redo, getCurrentProject } from "./commandHistory";
import { projectDocumentDraft, parseProjectDocument, documentToProject } from "./projectDocument";
import { titleDescriptor } from "./title";
import { fadeEnvelope } from "./clipAudioFade";
import type { MediaClip } from "./types";

const assetId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const project = createEmptyProject();
  project.assets = [{ id: assetId, kind: "video", ext: "mp4", streamUrl: `/api/assets/${assetId}/stream`, displayName: "source", sourceDurationSec: 20 }];
  const clip = clipFromAsset({ asset: project.assets[0], trackId: project.tracks[0].id, timelineStartSec: 2, durationSec: 6 });
  clip.parts = [{ assetId, sourceInSec: 3, sourceOutSec: 5 }, { assetId, sourceInSec: 9, sourceOutSec: 13 }];
  project.clips = [clip]; project.selectedClipIds = [clip.id]; project.playheadSec = 5.5; project.compositionDurationSec = 30;
  return { project, clip };
}
function roundTrip(project: ReturnType<typeof fixture>["project"]) {
  expect(documentToProject(parseProjectDocument(projectDocumentDraft(project))).clips).toEqual(project.clips);
}
describe("trim clip end at playhead", () => {
  it("keeps the source prefix and unrelated project state without mutating input", () => {
    const { project: p, clip } = fixture(), before = structuredClone(p);
    const n = trimClipEnd(p, clip.id, 5.5)!;
    expect(n.clips[0]).toEqual({ ...clip, durationSec: 3.5, parts: [clip.parts[0], { assetId, sourceInSec: 9, sourceOutSec: 10.5 }] });
    expect(n.clips[0].parts![0]).toBe(clip.parts[0]);
    expect({ ...n, clips: p.clips }).toEqual(p);
    expect(n.assets).toBe(p.assets); expect(n.tracks).toBe(p.tracks); expect(n.selectedClipIds).toBe(p.selectedClipIds);
    expect(p).toEqual(before); roundTrip(n);
  });
  it("keeps exact part boundaries and positive microscopic suffixes without an epsilon cut", () => {
    const { project: p, clip } = fixture();
    const exact = trimClipEnd(p, clip.id, 4)!; expect(exact.clips[0].parts).toEqual([clip.parts[0]]);
    const left = trimClipEnd(p, clip.id, 4 - 1e-12)!.clips[0].parts!;
    const right = trimClipEnd(p, clip.id, 4 + 1e-12)!.clips[0].parts!;
    expect(left).toHaveLength(1); expect(left[0].sourceOutSec).toBeLessThan(5);
    expect(right).toHaveLength(2); expect(right[1].sourceInSec).toBe(9); expect(right[1].sourceOutSec).toBeGreaterThan(9);
  });
  it.each([0, 2, 100, 86390])("accepts nominal MIN without widening its input boundary at start %s", start => {
    const { project: p, clip } = fixture(); clip.timelineStartSec = start; p.compositionDurationSec = 86400;
    const at = start + .05, n = applyCommand(p, { type: "trimEnd", clipId: clip.id, atSec: at })!;
    expect(n).not.toBeNull(); expect(n.clips[0].timelineStartSec).toBe(start); expect(n.clips[0].durationSec).toBeGreaterThanOrEqual(.05);
    expect(Math.abs(start + n.clips[0].durationSec - at)).toBeLessThanOrEqual(1e-9); roundTrip(n);
    expect(applyCommand(p, { type: "trimEnd", clipId: clip.id, atSec: at - 1e-8 })).toBeNull();
  });
  it.each([0, 5e-7, -5e-7, 9.9999999e-7, -9.9999999e-7])("accepts valid document duration drift %s", drift => {
    const { project: p, clip } = fixture(); clip.durationSec += drift;
    roundTrip(p); const n = trimClipEnd(p, clip.id, 5.5)!;
    expect(n.clips[0].durationSec).toBe(3.5); expect(n.clips[0].timelineStartSec).toBe(2); roundTrip(n);
  });
  it("retains complete parts when trimming inside a legal declared positive hold", () => {
    const { project: p, clip } = fixture(); clip.timelineStartSec = 0; clip.parts = [{ assetId, sourceInSec: 0, sourceOutSec: 1 }]; clip.durationSec = 1.0000005;
    const n = trimClipEnd(p, clip.id, 1.00000025)!;
    expect(n.clips[0].parts).toEqual(clip.parts); expect(n.clips[0].durationSec).toBe(1.00000025); roundTrip(n);
  });
  it("preserves min duration across 50 parts, large legal source timestamps and signed drift", () => {
    for (const start of [0, 2, 86300]) for (const source of [0, 3, 86300]) for (const drift of [0, 5e-7, -5e-7, 1e-6, -1e-6]) {
      const { project: p, clip } = fixture(); p.assets[0].sourceDurationSec = 86400; p.compositionDurationSec = 86400; clip.timelineStartSec = start;
      clip.parts = Array.from({ length: 50 }, (_, i) => ({ assetId, sourceInSec: source + i, sourceOutSec: source + i + .2 }));
      const sum = clip.parts.reduce((s, part) => s + part.sourceOutSec - part.sourceInSec, 0); clip.durationSec = sum + drift;
      if (Math.abs(clip.durationSec - sum) > 1e-6) continue; // Only accepted input documents.
      for (const retained of [.05, .2, 3.17, clip.durationSec - .01]) {
        const at = start + retained, n = trimClipEnd(p, clip.id, at);
        expect(n, JSON.stringify({ start, source, drift, at })).not.toBeNull();
        expect(n!.clips[0].timelineStartSec).toBe(start); expect(n!.compositionDurationSec).toBe(86400);
        expect(Math.abs(start + n!.clips[0].durationSec - at)).toBeLessThanOrEqual(1e-9); roundTrip(n!);
        expect(n!.clips[0].parts![0].sourceInSec).toBe(source);
      }
    }
  });
  it("keeps an atomic positive retained part at an exact representable boundary", () => {
    const { project: p, clip } = fixture(); const source = 86390, step = 1.4551915228366852e-11;
    p.assets[0].sourceDurationSec = 86400; clip.timelineStartSec = 0;
    clip.parts = [{ assetId, sourceInSec: 0, sourceOutSec: .1 }, { assetId, sourceInSec: source, sourceOutSec: source + step }, { assetId, sourceInSec: 1, sourceOutSec: 2 }];
    clip.durationSec = clip.parts.reduce((s, part) => s + part.sourceOutSec - part.sourceInSec, 0);
    const n = trimClipEnd(p, clip.id, .1 + step)!;
    expect(n.clips[0].parts).toHaveLength(2); expect(n.clips[0].parts![1]).toEqual(clip.parts[1]); roundTrip(n);
  });
  it("rejects unrepresentable pure-model source arithmetic without weakening document validation", () => {
    const { project: p, clip } = fixture(); clip.timelineStartSec = 0; clip.durationSec = 32768; clip.parts = [{ assetId, sourceInSec: 1e20, sourceOutSec: 1e20 + 32768 }];
    p.assets[0].kind = "image"; p.assets[0].ext = "png"; delete p.assets[0].sourceDurationSec; p.compositionDurationSec = 40000; p.playheadSec = 100;
    const original = structuredClone(p); expect(trimClipEnd(p, clip.id, 100)).toBeNull(); expect(trimEndReason(p)).toContain("素材の時刻精度");
    expect(() => parseProjectDocument(projectDocumentDraft(p))).toThrow(); expect(p).toEqual(original);
  });
  it.each(["stretch", "contain"] as const)("preserves %s geometry, image/job source and gain/fade anchors", layoutMode => {
    const { project: p, clip } = fixture(); p.assets[0] = { ...p.assets[0], sourceJobId: assetId, storageAssetId: assetId };
    clip.layoutMode = layoutMode; clip.transform = { x: .3, y: .7, scale: .6 }; clip.audioGain = .4; clip.audioFade = { inSec: 1, outSec: 1, anchorDurationSec: 10, offsetSec: .2 };
    const n = trimClipEnd(p, clip.id, 5.5)!.clips[0] as MediaClip;
    expect(n.audioFade).toBe(clip.audioFade); expect(n.audioGain).toBe(.4); expect(n.transform).toBe(clip.transform); expect(n.layoutMode).toBe(layoutMode);
    for (const u of [0, .5, 1, 2, 3.499]) expect(fadeEnvelope(n.audioFade!, u)).toBe(fadeEnvelope(clip.audioFade, u));
    p.assets[0].kind = "image"; p.assets[0].ext = "png";
    expect(trimClipEnd(p, clip.id, 5.5)!.clips[0].parts).toEqual(n.parts);
  });
  it("trims title time alone and retains version selection", () => {
    const { project: p, clip } = fixture(); p.clips = [{ id: clip.id, trackId: clip.trackId, timelineStartSec: 2, durationSec: 6, transform: clip.transform, kind: "title", ...titleDescriptor("日本語の章題") }];
    const n = trimClipEnd(p, clip.id, 5.5)!; expect(n.clips[0]).toEqual({ ...p.clips[0], durationSec: 3.5 });
    expect(projectDocumentDraft(n).version).toBe(4); roundTrip(n);
  });
  it("has one Undo/Redo and keeps pending Redo for invalid or repeated commands", () => {
    const { project: p, clip } = fixture(), h = createCommandHistory(p);
    const change = dispatchCommand(h, { type: "trimEnd", clipId: clip.id, atSec: 5.5 })!;
    expect(change.history.undoStack).toHaveLength(2); expect(getCurrentProject(undo(change.history)!)).toBe(p);
    const undone = undo(change.history)!;
    for (const atSec of [-1, 1, 2, 2.01, 8, 8 - 1e-10, 100, NaN, Infinity, -Infinity]) {
      expect(dispatchCommand(undone, { type: "trimEnd", clipId: clip.id, atSec })).toBeNull(); expect(undone.redoStack).toHaveLength(1);
    }
    expect(getCurrentProject(redo(undone)!)).toEqual(change.project);
    expect(dispatchCommand(change.history, { type: "trimEnd", clipId: clip.id, atSec: 5.5 })).toBeNull();
    for (const selectedClipIds of [[], [clip.id, "other"]]) expect(applyCommand({ ...p, selectedClipIds }, { type: "trimEnd", clipId: clip.id, atSec: 5.5 })).toBeNull();
    expect(trimClipEnd(p, "missing", 4)).toBeNull();
  });
  it("snapshots allow a newer playhead but reject changed epoch/selection/clip or source identity", () => {
    const { project: p } = fixture(), snapshot = trimEndSnapshot(p, 3)!;
    expect(matchesTrimEndSnapshot({ ...p, playheadSec: 6 }, 3, snapshot)).toBe(true); expect(matchesTrimEndSnapshot(p, 4, snapshot)).toBe(false);
    expect(matchesTrimEndSnapshot({ ...p, selectedClipIds: [] }, 3, snapshot)).toBe(false);
    for (const patch of [{ sourceJobId: assetId }, { storageAssetId: assetId }, { streamUrl: "changed" }, { sourceDurationSec: 99 }, { width: 999 }])
      expect(matchesTrimEndSnapshot({ ...p, assets: [{ ...p.assets[0], ...patch }] }, 3, snapshot)).toBe(false);
    for (const patch of [{ timelineStartSec: 3 }, { durationSec: 3 }, { transform: { x: 0, y: 0, scale: 2 } }])
      expect(matchesTrimEndSnapshot({ ...p, clips: [{ ...p.clips[0], ...patch }] }, 3, snapshot)).toBe(false);
  });
});
