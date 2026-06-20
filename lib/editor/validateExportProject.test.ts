import { describe, expect, it } from "vitest";
import { formatFfmpegFilterNumber } from "@/lib/exportComposition";
import { parseCompositionExportPayload } from "@/lib/editor/validateExportProject";

const assetId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const trackId = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const clipId = "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    compositionDurationSec: 30,
    exportBaseName: "demo",
    assets: [
      {
        id: assetId,
        kind: "video",
        ext: "mp4",
        displayName: "clip",
        sourceDurationSec: 30,
      },
    ],
    tracks: [{ id: trackId, order: 0 }],
    clips: [
      {
        id: clipId,
        trackId,
        timelineStartSec: 0,
        durationSec: 5,
        parts: [{ assetId, sourceInSec: 0, sourceOutSec: 5 }],
        transform: { x: 0.5, y: 0.5, scale: 1 },
      },
    ],
    ...overrides,
  };
}

describe("parseCompositionExportPayload", () => {
  it("accepts a well-formed export payload", () => {
    const parsed = parseCompositionExportPayload(validPayload());
    expect(parsed.project.clips).toHaveLength(1);
    expect(parsed.project.assets[0]?.streamUrl).toBe(`/api/assets/${assetId}/stream`);
  });

  it("rejects filter injection via string durationSec", () => {
    expect(() =>
      parseCompositionExportPayload(
        validPayload({
          clips: [
            {
              id: clipId,
              trackId,
              timelineStartSec: 0,
              durationSec: "1)'[vo0];[1:v]drawtext=text=INJECTED",
              parts: [{ assetId, sourceInSec: 0, sourceOutSec: 5 }],
              transform: { x: 0.5, y: 0.5, scale: 1 },
            },
          ],
        }),
      ),
    ).toThrow("有限の数値");
  });

  it("rejects string timelineStartSec", () => {
    expect(() =>
      parseCompositionExportPayload(
        validPayload({
          clips: [
            {
              id: clipId,
              trackId,
              timelineStartSec: "0",
              durationSec: 5,
              parts: [{ assetId, sourceInSec: 0, sourceOutSec: 5 }],
              transform: { x: 0.5, y: 0.5, scale: 1 },
            },
          ],
        }),
      ),
    ).toThrow("有限の数値");
  });

  it("rejects unknown asset references in clip parts", () => {
    expect(() =>
      parseCompositionExportPayload(
        validPayload({
          clips: [
            {
              id: clipId,
              trackId,
              timelineStartSec: 0,
              durationSec: 5,
              parts: [
                {
                  assetId: "d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44",
                  sourceInSec: 0,
                  sourceOutSec: 5,
                },
              ],
              transform: { x: 0.5, y: 0.5, scale: 1 },
            },
          ],
        }),
      ),
    ).toThrow("assets に存在しません");
  });

  it("rejects empty clips array", () => {
    expect(() => parseCompositionExportPayload(validPayload({ clips: [] }))).toThrow(
      "クリップがありません",
    );
  });
});

describe("formatFfmpegFilterNumber", () => {
  it("formats finite numbers safely", () => {
    expect(formatFfmpegFilterNumber(1.5)).toBe("1.5");
    expect(formatFfmpegFilterNumber(0)).toBe("0");
  });

  it("rejects non-numbers", () => {
    expect(() => formatFfmpegFilterNumber(Number.NaN)).toThrow();
    // @ts-expect-error runtime guard
    expect(() => formatFfmpegFilterNumber("1")).toThrow();
  });
});
