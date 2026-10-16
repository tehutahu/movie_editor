import { expect, it } from "vitest";
import { matchesMediaDimensions, videoDisplayDimensions } from "./videoDimensions";

it.each([0, 90, 180, 270, -90, -180, -270, 360, 450])(
  "recognizes display-matrix quarter turn %s without mutating encoded dimensions",
  (rotation) => {
    const stream = { width: 320, height: 180,
      side_data_list: [{ side_data_type: "Display Matrix", rotation }] };
    const expected = Math.abs(rotation % 180) === 90
      ? { width: 180, height: 320 } : { width: 320, height: 180 };
    expect(videoDisplayDimensions(stream)).toEqual(expected);
    expect(stream).toMatchObject({ width: 320, height: 180 });
  },
);
it.each([undefined, "90", null, NaN, Infinity, 45, 89.999, -23])(
  "keeps encoded dimensions for unknown/unsupported rotation %s", (rotation) => {
    expect(videoDisplayDimensions({ width: 320, height: 180,
      side_data_list: [{ side_data_type: "Display Matrix", rotation }] }))
      .toEqual({ width: 320, height: 180 });
  },
);
it("does not infer rotation from other side data, missing metadata or missing video", () => {
  expect(videoDisplayDimensions({ width: 320, height: 180,
    side_data_list: [{ side_data_type: "Other", rotation: 90 }] }))
    .toEqual({ width: 320, height: 180 });
  expect(videoDisplayDimensions({ width: 320, height: 180 }))
    .toEqual({ width: 320, height: 180 });
  expect(videoDisplayDimensions({})).toEqual({ width: undefined, height: undefined });
});
it("accepts complete raw or display pairs from the same probe, rejecting mixed pairs and arbitrary swaps", () => {
  const rotated = { width: 320, height: 180, displayWidth: 180, displayHeight: 320 };
  expect(matchesMediaDimensions({ width: 320, height: 180 }, rotated)).toBe(true);
  expect(matchesMediaDimensions({ width: 180, height: 320 }, rotated)).toBe(true);
  for (const invalid of [{ width: 320, height: 320 }, { width: 180, height: 180 },
    { width: 640, height: 360 }, { width: 180 }, { height: 320 }]) {
    expect(matchesMediaDimensions(invalid, rotated)).toBe(false);
  }
  expect(matchesMediaDimensions({ width: 180, height: 320 },
    { width: 320, height: 180, displayWidth: 320, displayHeight: 180 })).toBe(false);
  expect(matchesMediaDimensions({ width: 180, height: 320 }, { width: 320, height: 180 })).toBe(false);
});
it("preserves v1 absent/partial raw dimensions and image dimension checks", () => {
  const raw = { width: 320, height: 180 };
  for (const saved of [{}, { width: 320 }, { height: 180 }, raw]) {
    expect(matchesMediaDimensions(saved, raw)).toBe(true);
  }
  expect(matchesMediaDimensions({ width: 321 }, raw)).toBe(false);
  expect(matchesMediaDimensions({ height: 181 }, raw)).toBe(false);
});
