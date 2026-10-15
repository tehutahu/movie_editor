import { expect, it } from "vitest";
import { selectedClipExportRequest } from "./selectedClipExport";
import { createEmptyProject, clipFromAsset } from "./project";
import type { Asset } from "./types";
const a: Asset = { id: "a", kind: "video", ext: "mp4", streamUrl: "/a", displayName: "a", sourceDurationSec: 20, width: 640, height: 360 };
it("exports all noncontiguous parts including images, starting at zero #20", () => {
  const p = createEmptyProject(); p.assets = [a, { ...a, id: "i", kind: "image", ext: "png" }];
  const c = clipFromAsset({ asset: a, trackId: p.tracks[0]!.id, timelineStartSec: 8, durationSec: 5 });
  c.parts = [{ assetId: "a", sourceInSec: 2, sourceOutSec: 4 }, { assetId: "a", sourceInSec: 9, sourceOutSec: 10 }, { assetId: "i", sourceInSec: 0, sourceOutSec: 2 }];
  p.clips = [c];
  const req = selectedClipExportRequest(p, c);
  expect(req.url).toBe("/api/jobs/export-composition");
  expect(req.body).toMatchObject({ compositionDurationSec: 5, clips: [{ parts: c.parts, timelineStartSec: 0, durationSec: 5, transform: { x: .5, y: .5, scale: 2 } }] });
  expect(c.timelineStartSec).toBe(8);
});
it("preserves single video segment export and source job", () => {
  const p = createEmptyProject(); p.assets = [{ ...a, sourceJobId: "restored" }];
  const c = clipFromAsset({ asset: a, trackId: p.tracks[0]!.id, timelineStartSec: 3, durationSec: 2 });
  c.parts = [{ assetId: "a", sourceInSec: 4, sourceOutSec: 6 }];
  expect(selectedClipExportRequest(p, c)).toMatchObject({ url: "/api/jobs/export-segment", body: { videoId: "a", sourceJobId: "restored", startSec: 4, endSec: 6 } });
});
it("refuses missing later media instead of exporting a partial success", () => {
  const p = createEmptyProject(); p.assets = [a];
  const c = clipFromAsset({ asset: a, trackId: p.tracks[0]!.id, timelineStartSec: 0 });
  c.parts.push({ assetId: "missing", sourceInSec: 0, sourceOutSec: 1 });
  expect(() => selectedClipExportRequest(p, c)).toThrow(/素材/);
});
