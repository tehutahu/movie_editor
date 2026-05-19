import { describe, expect, it } from "vitest";

import {
  buildSegmentsFromMarkers,
  segmentsToRemoveRanges,
  type Segment,
} from "@/lib/segments";

describe("buildSegmentsFromMarkers", () => {
  it("マーカーが無ければ単一セグメント 0〜duration にする", () => {
    expect(buildSegmentsFromMarkers(10, [])).toEqual([
      expect.objectContaining({ startSec: 0, endSec: 10, index: 0 }),
    ]);
  });

  it("マーカーで複数セグメントに分割する（重複マーカーを除く）", () => {
    const segs = buildSegmentsFromMarkers(10, [3, 3, 7]);
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => [s.startSec, s.endSec])).toEqual([
      [0, 3],
      [3, 7],
      [7, 10],
    ]);
  });

  it("動画両端および範囲外のマーカーは無視する", () => {
    expect(buildSegmentsFromMarkers(10, [0, 10, -1, NaN])).toEqual([
      expect.objectContaining({ startSec: 0, endSec: 10 }),
    ]);
  });

  it("無効または極小の duration は空配列を返す", () => {
    expect(buildSegmentsFromMarkers(0, [1])).toEqual([]);
    expect(buildSegmentsFromMarkers(-1, [0.5])).toEqual([]);
    expect(buildSegmentsFromMarkers(Number.NaN, [1])).toEqual([]);
  });
});

describe("segmentsToRemoveRanges", () => {
  const segments: Segment[] = [
    { id: "seg-0", index: 0, startSec: 0, endSec: 5 },
    { id: "seg-1", index: 1, startSec: 5, endSec: 10 },
    { id: "seg-2", index: 2, startSec: 10, endSec: 15 },
  ];

  it("削除 ID に対応する区間のみを昇順で返す", () => {
    expect(
      segmentsToRemoveRanges(new Set(["seg-2", "seg-0"]), segments),
    ).toEqual([
      { startSec: 0, endSec: 5 },
      { startSec: 10, endSec: 15 },
    ]);
  });

  it("削除が無ければ空配列", () => {
    expect(segmentsToRemoveRanges(new Set([]), segments)).toEqual([]);
  });
});
