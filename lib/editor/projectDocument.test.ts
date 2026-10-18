import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createEmptyProject, clipFromAsset } from "./project";
import {
  documentToProject,
  parseProjectDocument,
  projectContentKey,
  projectDocumentDraft,
  MAX_PROJECT_JSON_BYTES,
} from "./projectDocument";
const asset = () => ({
  id: randomUUID(),
  kind: "video" as const,
  ext: "mp4",
  displayName: "movie",
  sourceDurationSec: 3,
  width: 320,
  height: 240,
  streamUrl: "https://never-access.invalid/private",
});
function fixture() {
  const p = createEmptyProject();
  p.assets = [asset()];
  p.clips = [
    clipFromAsset({
      asset: p.assets[0],
      trackId: p.tracks[0].id,
      timelineStartSec: 1,
    }),
  ];
  return p;
}
describe("versioned save DTO", () => {
  it("roundtrips empty and library-only projects independently of export validation", () => {
    for (const p of [
      createEmptyProject(),
      { ...createEmptyProject(), assets: [asset()] },
    ])
      expect(
        documentToProject(parseProjectDocument(projectDocumentDraft(p))).clips,
      ).toEqual([]);
  });
  it("preserves joined parts and transforms, excluding all transient state", () => {
    const p = fixture();
    p.clips[0].parts = [
      { assetId: p.assets[0].id, sourceInSec: 0, sourceOutSec: 1 },
      { assetId: p.assets[0].id, sourceInSec: 1, sourceOutSec: 3 },
    ];
    p.clips[0].transform = { x: 0.3, y: 0.7, scale: 0.6 };
    p.playheadSec = 2;
    p.selectedClipIds = [p.clips[0].id];
    const doc = parseProjectDocument({
      ...projectDocumentDraft(p),
      undoStack: ["secret"],
      path: "/etc/passwd",
    });
    expect(JSON.stringify(doc)).not.toMatch(
      /https:|streamUrl|playheadSec|selectedClipIds|undoStack|passwd/,
    );
    const loaded = documentToProject(doc);
    expect(loaded.clips).toEqual(p.clips);
    expect(loaded.playheadSec).toBe(0);
    expect(loaded.selectedClipIds).toEqual([]);
  });
  it("uses the restored output rather than original bytes", () => {
    const p = fixture();
    p.assets[0] = {
      ...p.assets[0],
      sourceJobId: randomUUID(),
    } as (typeof p.assets)[0];
    expect(projectDocumentDraft(p).project.assets[0].media.id).toBe(
      (p.assets[0] as { sourceJobId?: string }).sourceJobId,
    );
  });
  it("only marks document changes dirty", () => {
    const p = fixture(),
      key = projectContentKey(p);
    p.playheadSec = 2;
    p.selectedClipIds = [p.clips[0].id];
    p.assets[0].streamUrl = "other";
    expect(projectContentKey(p)).toBe(key);
    p.exportBaseName = "changed";
    expect(projectContentKey(p)).not.toBe(key);
  });
  it.each([
    "version",
    "duplicateAsset",
    "duplicateClip",
    "duplicateTrack",
    "reference",
    "interval",
    "numeric",
    "count",
    "size",
    "path",
  ])("rejects %s", (kind) => {
    const doc = projectDocumentDraft(fixture());
    switch (kind) {
      case "version":
        Object.assign(doc, { version: 99 });
        break;
      case "duplicateAsset":
        doc.project.assets.push(doc.project.assets[0]);
        break;
      case "duplicateClip":
        doc.project.clips.push(doc.project.clips[0]);
        break;
      case "duplicateTrack":
        doc.project.tracks.push(doc.project.tracks[0]);
        break;
      case "reference":
        doc.project.clips[0].parts![0].assetId = randomUUID();
        break;
      case "interval":
        doc.project.clips[0].parts![0].sourceOutSec = 100;
        break;
      case "numeric":
        doc.project.clips[0].transform.scale = NaN;
        break;
      case "count":
        doc.project.assets = Array(51).fill(doc.project.assets[0]);
        break;
      case "size":
        doc.project.exportBaseName = "x".repeat(MAX_PROJECT_JSON_BYTES);
        break;
      case "path":
        doc.project.assets[0].media.id = "../../etc/passwd";
        break;
    }
    expect(() => parseProjectDocument(doc)).toThrow();
  });
});
