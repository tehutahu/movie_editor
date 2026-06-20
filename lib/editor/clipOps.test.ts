import { describe, expect, it } from "vitest";
import { createEmptyProject, clipFromAsset } from "@/lib/editor/project";
import { splitClipAtPlayhead, mergeClips, moveClip, resolveNonOverlappingStart, duplicateClips } from "@/lib/editor/clipOps";
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
    expect(merged!.clips[0]!.parts).toHaveLength(2);
  });

  it("merges non-adjacent clips in timeline order", () => {
    const asset2: Asset = {
      ...videoAsset,
      id: "a2",
      displayName: "other.mp4",
    };
    let project = createEmptyProject();
    const track = project.tracks[0]!;
    const c1 = clipFromAsset({ asset: videoAsset, trackId: track.id, timelineStartSec: 0, durationSec: 3 });
    const c2 = clipFromAsset({ asset: asset2, trackId: track.id, timelineStartSec: 8, durationSec: 2 });
    project = { ...project, assets: [videoAsset, asset2], clips: [c1, c2] };

    const merged = mergeClips(project, [c2.id, c1.id]);
    expect(merged).not.toBeNull();
    expect(merged!.clips).toHaveLength(1);
    expect(merged!.clips[0]!.timelineStartSec).toBe(0);
    expect(merged!.clips[0]!.durationSec).toBeCloseTo(5, 2);
    expect(merged!.clips[0]!.parts[0]!.assetId).toBe("a1");
    expect(merged!.clips[0]!.parts[1]!.assetId).toBe("a2");
  });

  it("prevents overlap when moving on same track", () => {
    let project = createEmptyProject();
    const track = project.tracks[0]!;
    const c1 = clipFromAsset({ asset: videoAsset, trackId: track.id, timelineStartSec: 0, durationSec: 3 });
    const c2 = clipFromAsset({ asset: videoAsset, trackId: track.id, timelineStartSec: 5, durationSec: 2 });
    project = { ...project, assets: [videoAsset], clips: [c1, c2] };

    const moved = moveClip(project, c2.id, 1);
    expect(moved.clips.find((c) => c.id === c2.id)!.timelineStartSec).toBe(3);
  });

  it("resolves non-overlapping start toward nearest edge", () => {
    const clips = [
      clipFromAsset({ asset: videoAsset, trackId: "t1", timelineStartSec: 0, durationSec: 4 }),
      clipFromAsset({ asset: videoAsset, trackId: "t1", timelineStartSec: 6, durationSec: 2 }),
    ];
    const moving = clips[1]!;
    expect(resolveNonOverlappingStart(clips, moving.id, "t1", 2, moving.durationSec)).toBe(4);
    expect(resolveNonOverlappingStart(clips, moving.id, "t1", 5, moving.durationSec)).toBe(5);
  });

  it("moves clip", () => {
    let project = createEmptyProject();
    const track = project.tracks[0]!;
    const clip = clipFromAsset({ asset: videoAsset, trackId: track.id, timelineStartSec: 0 });
    project = { ...project, assets: [videoAsset], clips: [clip] };

    const moved = moveClip(project, clip.id, 2);
    expect(moved.clips[0]!.timelineStartSec).toBe(2);
  });

  it("duplicates clip onto another track at same time", () => {
    let project = createEmptyProject();
    const trackA = project.tracks[0]!;
    const trackB = project.tracks[1]!;
    const clip = clipFromAsset({
      asset: videoAsset,
      trackId: trackA.id,
      timelineStartSec: 2,
      durationSec: 4,
      tracks: project.tracks,
    });
    project = { ...project, assets: [videoAsset], clips: [clip] };

    const duplicated = duplicateClips(project, [clip.id]);
    expect(duplicated).not.toBeNull();
    expect(duplicated!.clips).toHaveLength(2);
    const copy = duplicated!.clips.find((c) => c.id !== clip.id)!;
    expect(copy.trackId).toBe(trackB.id);
    expect(copy.timelineStartSec).toBe(2);
    expect(copy.durationSec).toBeCloseTo(4, 2);
    expect(duplicated!.selectedClipIds).toEqual([copy.id]);
  });

  it("adds a track when duplicating with no free track at same time", () => {
    let project = createEmptyProject();
    const trackA = project.tracks[0]!;
    const trackB = project.tracks[1]!;
    const c1 = clipFromAsset({
      asset: videoAsset,
      trackId: trackA.id,
      timelineStartSec: 0,
      durationSec: 4,
      tracks: project.tracks,
    });
    const c2 = clipFromAsset({
      asset: videoAsset,
      trackId: trackB.id,
      timelineStartSec: 0,
      durationSec: 4,
      tracks: project.tracks,
    });
    project = { ...project, assets: [videoAsset], clips: [c1, c2] };

    const duplicated = duplicateClips(project, [c1.id]);
    expect(duplicated).not.toBeNull();
    expect(duplicated!.tracks).toHaveLength(3);
    const copy = duplicated!.clips.find((c) => c.id !== c1.id && c.id !== c2.id)!;
    expect(copy.trackId).not.toBe(trackA.id);
    expect(copy.timelineStartSec).toBe(0);
  });
});
