import { describe, expect, it } from "vitest";
import {
  clipContainsNormPoint,
  clipsForExportComposition,
  compositionSizeForFirstClip,
  compositionSizeFromAsset,
  DEFAULT_COMPOSITION_HEIGHT,
  DEFAULT_COMPOSITION_WIDTH,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  fitClipTransformToCanvas,
  hitTestTransformHandle,
  transformFromMove,
  transformFromResize,
  transformToPixelRect,
} from "@/lib/editor/compositor";
import { DEFAULT_TRANSFORM, type Asset } from "@/lib/editor/types";
import { createEmptyProject } from "@/lib/editor/project";

describe("compositor transform helpers", () => {
  it("clipContainsNormPoint respects scale", () => {
    const t = { x: 0.5, y: 0.5, scale: 1 };
    expect(clipContainsNormPoint(t, 0.5, 0.5)).toBe(true);
    expect(clipContainsNormPoint(t, 0.1, 0.1)).toBe(false);
    expect(clipContainsNormPoint({ ...t, scale: 2 }, 0.1, 0.1)).toBe(true);
  });

  it("hitTestTransformHandle finds corners", () => {
    const t = { x: 0.5, y: 0.5, scale: 1 };
    expect(hitTestTransformHandle(t, 0.75, 0.75, 800, 450, 12)).toBe("se");
    expect(hitTestTransformHandle(t, 0.25, 0.25, 800, 450, 12)).toBe("nw");
    expect(hitTestTransformHandle(t, 0.5, 0.5, 800, 450, 12)).toBe(null);
  });

  it("transformFromMove offsets center", () => {
    const next = transformFromMove(DEFAULT_TRANSFORM, 0.1, -0.05);
    expect(next.x).toBeCloseTo(0.6);
    expect(next.y).toBeCloseTo(0.45);
    expect(next.scale).toBe(1);
  });

  it("transformFromResize grows from se handle", () => {
    const t = { x: 0.5, y: 0.5, scale: 1 };
    const next = transformFromResize(t, "se", { x: 600, y: 400 }, 800, 450);
    expect(next.scale).toBeGreaterThan(1);
    expect(next.x).toBeGreaterThan(0.5);
    expect(next.y).toBeGreaterThan(0.5);
  });

  it("transformToPixelRect matches preview layout at export resolution", () => {
    const rect = transformToPixelRect(DEFAULT_TRANSFORM, EXPORT_WIDTH, EXPORT_HEIGHT);
    expect(rect.w).toBe(960);
    expect(rect.h).toBe(540);
    expect(rect.x).toBe(480);
    expect(rect.y).toBe(270);
  });

  it("fitClipTransformToCanvas fills the frame", () => {
    const fit = fitClipTransformToCanvas();
    const rect = transformToPixelRect(fit, EXPORT_WIDTH, EXPORT_HEIGHT);
    expect(rect.w).toBe(EXPORT_WIDTH);
    expect(rect.h).toBe(EXPORT_HEIGHT);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
  });

  it("clipsForExportComposition sorts background tracks first", () => {
    let project = createEmptyProject();
    const bgTrack = project.tracks[0]!;
    const fgTrack = project.tracks[1]!;
    project = {
      ...project,
      clips: [
        {
          id: "fg",
          trackId: fgTrack.id,
          timelineStartSec: 0,
          durationSec: 2,
          parts: [{ assetId: "a1", sourceInSec: 0, sourceOutSec: 2 }],
          transform: DEFAULT_TRANSFORM,
        },
        {
          id: "bg",
          trackId: bgTrack.id,
          timelineStartSec: 0,
          durationSec: 2,
          parts: [{ assetId: "a2", sourceInSec: 0, sourceOutSec: 2 }],
          transform: DEFAULT_TRANSFORM,
        },
      ],
      assets: [
        {
          id: "a1",
          kind: "video",
          streamUrl: "/a1",
          displayName: "fg",
          ext: "mp4",
        },
        {
          id: "a2",
          kind: "video",
          streamUrl: "/a2",
          displayName: "bg",
          ext: "mp4",
        },
      ],
    };

    const layers = clipsForExportComposition(project);
    expect(layers.map((l) => l.clip.id)).toEqual(["bg", "fg"]);
  });
});

describe("compositionSizeFromAsset", () => {
  it("scales landscape 4K down to 1920 long edge", () => {
    const size = compositionSizeFromAsset(3840, 2160);
    expect(size.width).toBe(1920);
    expect(size.height).toBe(1080);
  });

  it("preserves portrait aspect with 1920 long edge", () => {
    const size = compositionSizeFromAsset(1080, 1920);
    expect(size.width).toBe(1080);
    expect(size.height).toBe(1920);
  });

  it("handles square assets", () => {
    const size = compositionSizeFromAsset(2000, 2000);
    expect(size.width).toBe(1920);
    expect(size.height).toBe(1920);
  });

  it("returns even dimensions", () => {
    const size = compositionSizeFromAsset(1001, 1779);
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
  });

  it("falls back to default for invalid asset dimensions", () => {
    const size = compositionSizeFromAsset(0, 1920);
    expect(size.width).toBe(DEFAULT_COMPOSITION_WIDTH);
    expect(size.height).toBe(DEFAULT_COMPOSITION_HEIGHT);
  });
});

describe("compositionSizeForFirstClip", () => {
  const portraitAsset: Asset = {
    id: "a1",
    kind: "video",
    streamUrl: "/a1",
    displayName: "portrait.mp4",
    ext: "mp4",
    width: 1080,
    height: 1920,
  };

  it("returns size when timeline is empty and asset has dimensions", () => {
    const project = createEmptyProject();
    expect(compositionSizeForFirstClip(project, portraitAsset)).toEqual({
      compositionWidth: 1080,
      compositionHeight: 1920,
    });
  });

  it("returns null when clips already exist", () => {
    let project = createEmptyProject();
    const track = project.tracks[0]!;
    project = {
      ...project,
      clips: [
        {
          id: "c1",
          trackId: track.id,
          timelineStartSec: 0,
          durationSec: 5,
          parts: [{ assetId: "a1", sourceInSec: 0, sourceOutSec: 5 }],
          transform: DEFAULT_TRANSFORM,
        },
      ],
    };
    expect(compositionSizeForFirstClip(project, portraitAsset)).toBeNull();
  });

  it("returns null when asset dimensions are missing", () => {
    const project = createEmptyProject();
    const asset: Asset = {
      id: "a2",
      kind: "video",
      streamUrl: "/a2",
      displayName: "unknown.mp4",
      ext: "mp4",
    };
    expect(compositionSizeForFirstClip(project, asset)).toBeNull();
  });
});
