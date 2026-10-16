import { expect, it } from "vitest";
import { matchesRestoreSource, parseRestoreResultMetadata, restoreSource } from "./restoreResult";
import { createEmptyProject } from "./project";
const metadata = { jobId: "job", hasVideo: true, durationSec: 2, width: 180, height: 320 };
it("takes paired result dimensions with duration and accepts valid odd sizes", () => {
  expect(parseRestoreResultMetadata(metadata, "job")).toEqual({ restoredDurationSec: 2, restoredWidth: 180, restoredHeight: 320 });
  expect(parseRestoreResultMetadata({ ...metadata, width: 321, height: 181 }, "job")).toMatchObject({ restoredWidth: 321, restoredHeight: 181 });
});
it.each([null, [], "invalid", {}, { ...metadata, jobId: "another" }, { ...metadata, hasVideo: false },
  { ...metadata, hasVideo: undefined }, { ...metadata, width: undefined }, { ...metadata, height: undefined },
  { ...metadata, width: "180" }, { ...metadata, width: 0 }, { ...metadata, height: -1 },
  { ...metadata, width: 1.5 }, { ...metadata, height: NaN }, { ...metadata, height: Infinity },
  { ...metadata, width: 65537 }, { ...metadata, durationSec: 0 }, { ...metadata, durationSec: NaN },
  { ...metadata, durationSec: Infinity }])("rejects unrelated, non-video or invalid metadata %j", (invalid) => {
  expect(() => parseRestoreResultMetadata(invalid, "job")).toThrow();
});
it("checks only the target source identity, so unrelated edits do not cancel the result", () => {
  const p = createEmptyProject(); p.assets = [{ id: "a", kind: "video", ext: "mp4", displayName: "sample", streamUrl: "/stream", sourceJobId: "previous" }];
  const identity = restoreSource(p.assets[0]);
  expect(matchesRestoreSource(p, identity)).toBe(true);
  const navigated = { ...p, playheadSec: 3, selectedClipIds: ["another"], compositionWidth: 640 };
  expect(matchesRestoreSource(navigated, identity)).toBe(true);
  for (const changed of [{ sourceJobId: "other" }, { streamUrl: "/other" }, { storageAssetId: "relinked" }, { kind: "image" as const }]) {
    expect(matchesRestoreSource({ ...p, assets: [{ ...p.assets[0], ...changed }] }, identity)).toBe(false);
  }
  expect(matchesRestoreSource({ ...p, assets: [] }, identity)).toBe(false);
});
