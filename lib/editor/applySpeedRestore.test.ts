import { describe, expect, it } from "vitest";
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
    });

    expect(next.assets[0]!.streamUrl).toBe("/api/jobs/job-restore-1/stream");
    expect(next.assets[0]!.sourceJobId).toBe("job-restore-1");
    expect(next.assets[0]!.sourceDurationSec).toBe(20);
    expect(next.clips[0]!.durationSec).toBeCloseTo(20, 2);
    expect(next.clips[0]!.parts[0]!.sourceOutSec).toBeCloseTo(20, 2);
    expect(next.compositionDurationSec).toBeCloseTo(20, 2);
  });
});
