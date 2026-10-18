import { describe, expect, it } from "vitest";
import { restorePopupPlacement } from "./restorePopupPlacement";

describe("restore popup viewport placement", () => {
  it("anchors above the whole toolbar without increasing document flow", () => {
    expect(restorePopupPlacement({ top: 560, right: 1240 }, { left: 0, top: 0, width: 1280, height: 720 }))
      .toEqual({ left: 930, width: 310, maxHeight: 320, bottom: 556 });
  });
  it("uses the actual upper space for the internal scrollport", () => {
    expect(restorePopupPlacement({ top: 150.25, right: 220 }, { left: 0, top: 0, width: 240, height: 720 }))
      .toEqual({ left: 12, width: 216, maxHeight: 134, bottom: 146.25 });
  });
  it("uses visual viewport offsets and clamps both horizontal edges", () => {
    const viewport = { left: 100, top: 50, width: 500, height: 400 };
    expect(restorePopupPlacement({ top: 600, right: 1000 }, viewport))
      .toEqual({ left: 278, width: 310, maxHeight: 320, bottom: 438 });
    expect(restorePopupPlacement({ top: 300, right: 0 }, viewport)?.left).toBe(112);
  });
  it("keeps the exact minimum usable space and rejects less", () => {
    expect(restorePopupPlacement({ top: 96, right: 172 }, { left: 0, top: 0, width: 184, height: 720 }))
      .toEqual({ left: 12, width: 160, maxHeight: 80, bottom: 92 });
    expect(restorePopupPlacement({ top: 95.99, right: 172 }, { left: 0, top: 0, width: 184, height: 720 })).toBeNull();
    expect(restorePopupPlacement({ top: 500, right: 172 }, { left: 0, top: 0, width: 183.99, height: 720 })).toBeNull();
  });
  it("fails closed for nonfinite or empty geometry", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(restorePopupPlacement({ top: invalid, right: 500 }, { left: 0, top: 0, width: 1280, height: 720 })).toBeNull();
      expect(restorePopupPlacement({ top: 500, right: 500 }, { left: 0, top: invalid, width: 1280, height: 720 })).toBeNull();
    }
    expect(restorePopupPlacement({ top: 500, right: 500 }, { left: 0, top: 0, width: 0, height: 720 })).toBeNull();
    expect(restorePopupPlacement({ top: 500, right: 500 }, { left: Number.MAX_VALUE, top: 0, width: Number.MAX_VALUE, height: 720 })).toBeNull();
  });
});
