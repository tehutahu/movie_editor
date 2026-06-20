import { describe, expect, it } from "vitest";

import type { Range } from "@/lib/validation";
import {
  assertPositiveInt,
  assertPositiveNumber,
  assertStorageId,
  keptRangesAfterRemovals,
  normalizeRanges,
  parseAllowedVideoExtension,
} from "@/lib/validation";

describe("assertStorageId", () => {
  const validId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

  it("検証済みの UUID はそのまま返す", () => {
    expect(assertStorageId("id", validId)).toBe(validId);
  });

  it("不正な形式は例外", () => {
    expect(() => assertStorageId("id", "hello")).toThrow("形式が不正");
  });
});

describe("parseAllowedVideoExtension", () => {
  it.each([
    ["clip.MP4", "mp4"],
    ["movie.mkv", "mkv"],
  ])("%s は許可される", (name, ext) => {
    expect(parseAllowedVideoExtension(name)).toBe(ext);
  });

  it("許可リスト外は null", () => {
    expect(parseAllowedVideoExtension("x.webm")).toBeNull();
  });
});

describe("assertPositiveNumber / assertPositiveInt", () => {
  it("assertPositiveNumber は文字列・数値の正の有限値を許可する", () => {
    expect(assertPositiveNumber("x", "2.5")).toBe(2.5);
    expect(assertPositiveNumber("y", 1)).toBe(1);
    expect(() => assertPositiveNumber("z", 0)).toThrow();
    expect(() => assertPositiveNumber("w", NaN)).toThrow();
  });

  it("assertPositiveInt は整数のみ", () => {
    expect(assertPositiveInt("x", 3)).toBe(3);
    expect(() => assertPositiveInt("y", 2.5)).toThrow();
  });
});

describe("assertStrictFiniteNumber", () => {
  it("requires typeof number", async () => {
    const { assertStrictFiniteNumber } = await import("@/lib/validation");
    expect(assertStrictFiniteNumber("x", 1)).toBe(1);
    expect(() => assertStrictFiniteNumber("x", "1")).toThrow("有限の数値");
    expect(() => assertStrictFiniteNumber("x", NaN)).toThrow();
  });
});

describe("normalizeRanges", () => {
  it("配列が空または非配列だとエラー", () => {
    expect(() => normalizeRanges(10, [])).toThrow();
    expect(() => normalizeRanges(10, null)).toThrow();
  });

  it("無効エントリを拒否する", () => {
    expect(() =>
      normalizeRanges(10, [{ startSec: "x", endSec: 1 }]),
    ).toThrow();
  });

  it("start が end 以上だとエラー", () => {
    expect(() => normalizeRanges(10, [{ startSec: 5, endSec: 5 }])).toThrow();
    expect(() => normalizeRanges(10, [{ startSec: 6, endSec: 4 }])).toThrow();
  });

  it("動画長を超える区間でエラー", () => {
    expect(() =>
      normalizeRanges(10, [{ startSec: 0, endSec: 11 }]),
    ).toThrow("動画長を超え");
  });

  it("start/end エイリアスを解釈し、昇順ソートして end を duration に収める", () => {
    const out = normalizeRanges(10, [
      { start: 8, finish: 10 },
      { begin: 2, end: 4 },
      { startSec: 5, endSec: 6 },
    ]);
    expect(out).toEqual([
      { startSec: 2, endSec: 4 },
      { startSec: 5, endSec: 6 },
      { startSec: 8, endSec: 10 },
    ]);
  });
});

describe("keptRangesAfterRemovals", () => {
  it("削除をマージした上で残す区間を返す", () => {
    const remove: Range[] = [
      { startSec: 2, endSec: 4 },
      { startSec: 3, endSec: 5 },
      { startSec: 9, endSec: 10 },
    ];
    expect(keptRangesAfterRemovals(10, remove)).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 5, endSec: 9 },
    ]);
  });

  it("削除で全体が消える場合はエラー", () => {
    expect(() =>
      keptRangesAfterRemovals(10, [{ startSec: 0, endSec: 10 }]),
    ).toThrow("残り区間がありません");
  });

  it("無効な duration はエラー", () => {
    expect(() => keptRangesAfterRemovals(0, [])).toThrow("無効な動画長");
  });
});
