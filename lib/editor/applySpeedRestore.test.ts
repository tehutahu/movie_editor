import { describe, expect, it } from "vitest";
import { createCommandHistory, dispatchCommand, getCurrentProject, undo, redo } from "./commandHistory";
import type { EditorCommand } from "./commands";
import { applySpeedRestoreToProject } from "@/lib/editor/applySpeedRestore";
import { clipFromAsset, createEmptyProject } from "@/lib/editor/project";
import type { Asset } from "@/lib/editor/types";

const videoAsset: Asset = {
  id: "a1",
  kind: "video",
  streamUrl: "/api/assets/a1/stream",
  displayName: "test.mp4",
  sourceDurationSec: 10,
  ext: "mp4",
};

describe("applySpeedRestoreToProject", () => {
  it("updates asset stream, clip duration, and source range", () => {
    let project = createEmptyProject();
    const track = project.tracks[0]!;
    const clip = clipFromAsset({ asset: videoAsset, trackId: track.id, timelineStartSec: 0 });
    project = { ...project, assets: [videoAsset], clips: [clip] };

    const next = applySpeedRestoreToProject(project, {
      assetId: "a1",
      jobId: "job-restore-1",
      speedFactor: 2,
      restoredDurationSec: 20,
      restoredWidth: 180,
      restoredHeight: 320,
    });

    expect(next.assets[0]!.streamUrl).toBe("/api/jobs/job-restore-1/stream");
    expect(next.assets[0]!.sourceJobId).toBe("job-restore-1");
    expect(next.assets[0]!.sourceDurationSec).toBe(20);
    expect(next.clips[0]!.durationSec).toBeCloseTo(20, 2);
    expect(next.clips[0]!.parts[0]!.sourceOutSec).toBeCloseTo(20, 2);
    expect(next.compositionDurationSec).toBeCloseTo(20, 2);
  });
});

it("restores shared asset dimensions and source in one history entry; Undo/Redo preserve the original layout", () => {
  const p = createEmptyProject();
  const original = { ...videoAsset, width: 320, height: 180 };
  const other = { ...videoAsset, id: "other", width: 640, height: 360 };
  p.assets = [original, other];
  p.clips = [0, 4].map((timelineStartSec, i) => ({
    ...clipFromAsset({ asset: original, trackId: p.tracks[i].id, timelineStartSec }),
    transform: { x: 0.2 + i * 0.1, y: 0.7, scale: 0.8 },
  }));
  p.compositionWidth = 640; p.compositionHeight = 360;
  const before = structuredClone(p);
  const history = createCommandHistory(p);
  const result = dispatchCommand(history, { type: "restoreSpeed", assetId: original.id, jobId: "restored",
    speedFactor: 2, restoredDurationSec: 20, restoredWidth: 180, restoredHeight: 320 })!;
  expect(result.history.undoStack).toHaveLength(2);
  expect(result.project.assets[0]).toMatchObject({ width: 180, height: 320,
    sourceJobId: "restored", sourceDurationSec: 20, streamUrl: "/api/jobs/restored/stream" });
  expect(result.project.assets[1]).toEqual(other);
  expect(result.project).toMatchObject({ compositionWidth: 640, compositionHeight: 360 });
  for (let i = 0; i < 2; i++) {
    expect(result.project.clips[i]).toMatchObject({ timelineStartSec: p.clips[i].timelineStartSec,
      transform: p.clips[i].transform, durationSec: 20 });
    expect(result.project.clips[i].parts[0]).toMatchObject({ assetId: original.id, sourceOutSec: 20 });
  }
  expect(p).toEqual(before);
  const undone = undo(result.history)!;
  expect(getCurrentProject(undone)).toEqual(before);
  expect(getCurrentProject(redo(undone)!)).toEqual(result.project);
});

it.each([
  { restoredWidth: 0 }, { restoredWidth: -1 }, { restoredWidth: NaN }, { restoredHeight: Infinity },
  { restoredWidth: 1.5 }, { restoredHeight: 65537 }, { restoredWidth: undefined },
  { restoredHeight: undefined }, { restoredWidth: "180" }, { restoredDurationSec: 0 },
  { restoredDurationSec: NaN }, { restoredDurationSec: Infinity },
])("rejects invalid restore metadata %j without changing input, history or Redo", (invalid) => {
  const p = createEmptyProject(); p.assets = [{ ...videoAsset, width: 320, height: 180 }];
  p.clips = [clipFromAsset({ asset: p.assets[0], trackId: p.tracks[0].id, timelineStartSec: 0 })];
  const history = undo(dispatchCommand(createCommandHistory(p), { type: "addTrack" })!.history)!;
  const before = structuredClone(history);
  const command = { type: "restoreSpeed" as const, assetId: videoAsset.id, jobId: "result",
    speedFactor: 2, restoredDurationSec: 20, restoredWidth: 180, restoredHeight: 320, ...invalid };
  expect(() => dispatchCommand(history, command as EditorCommand)).toThrow();
  expect(history).toEqual(before);
  expect(p).toEqual(getCurrentProject(history));
});
