import { describe, expect, it } from "vitest";
import { createEmptyProject, clipFromAsset } from "@/lib/editor/project";
import { splitClipAtPlayhead, mergeClips, moveClip } from "@/lib/editor/clipOps";
import type { Asset } from "@/lib/editor/types";

const videoAsset: Asset = {
  id: "a1",
  kind: "video",
  streamUrl: "/api/assets/a1/stream",
  displayName: "test.mp4",
  sourceDurationSec: 10,
  ext: "mp4",
};

describe("clipOps", () => {
  it("splits clip at playhead", () => {
    let project = createEmptyProject();
    const track = project.tracks[0]!;
    const clip = clipFromAsset({ asset: videoAsset, trackId: track.id, timelineStartSec: 0 });
    project = { ...project, assets: [videoAsset], clips: [clip] };

    const split = splitClipAtPlayhead(project, clip.id, 5);
    expect(split).not.toBeNull();
    expect(split!.clips).toHaveLength(2);
    expect(split!.clips[0]!.durationSec).toBeCloseTo(5, 2);
    expect(split!.clips[1]!.durationSec).toBeCloseTo(5, 2);
  });

  it("merges adjacent clips on same track", () => {
    let project = createEmptyProject();
    const track = project.tracks[0]!;
    const c1 = clipFromAsset({ asset: videoAsset, trackId: track.id, timelineStartSec: 0, durationSec: 3 });
    const c2 = clipFromAsset({ asset: videoAsset, trackId: track.id, timelineStartSec: 3, durationSec: 2 });
    project = { ...project, assets: [videoAsset], clips: [c1, c2] };

    const merged = mergeClips(project, [c1.id, c2.id]);
    expect(merged).not.toBeNull();
    expect(merged!.clips).toHaveLength(1);
    expect(merged!.clips[0]!.durationSec).toBeCloseTo(5, 2);
  });

  it("moves clip", () => {
    let project = createEmptyProject();
    const track = project.tracks[0]!;
    const clip = clipFromAsset({ asset: videoAsset, trackId: track.id, timelineStartSec: 0 });
    project = { ...project, assets: [videoAsset], clips: [clip] };

    const moved = moveClip(project, clip.id, 2);
    expect(moved.clips[0]!.timelineStartSec).toBe(2);
  });
});
