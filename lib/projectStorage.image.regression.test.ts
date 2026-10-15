import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { probeImage, probeVideo } from "./ffmpeg";
import { saveProject, loadProject, deleteProject } from "./projectStorage";
import { reserveStorage, releaseStorageSession } from "./storageRetention";
import { createEmptyProject, clipFromAsset } from "./editor/project";
import { projectDocumentDraft } from "./editor/projectDocument";
import { UPLOADS_ROOT } from "./paths";

const real = process.env.RUN_FFMPEG_TESTS === "1";

it.skipIf(!real).each(["png", "jpg"])(
  "real ffmpeg: %s image saves, survives session release, and loads without a video duration",
  async (ext) => {
    const id = randomUUID(), session = randomUUID(), loadedSession = randomUUID();
    const revisionId = randomUUID();
    await reserveStorage([{ id, kind: "uploads" }], session);
    const dir = path.join(UPLOADS_ROOT, id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `input.${ext}`);
    execFileSync(process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=64x48",
      "-frames:v", "1", file,
    ]);
    const metadata = await probeImage(file);
    expect(metadata).toEqual({ width: 64, height: 48, hasVideo: true });
    await expect(probeVideo(file)).rejects.toThrow(/duration/);
    const project = createEmptyProject();
    project.assets = [{ id, kind: "image", ext, displayName: "still", streamUrl: "/ignored", width: 64, height: 48 }];
    project.clips = [clipFromAsset({ asset: project.assets[0], trackId: project.tracks[0].id, timelineStartSec: 0 })];
    project.compositionDurationSec = project.clips[0].durationSec;
    try {
      const saved = await saveProject(revisionId, projectDocumentDraft(project));
      await releaseStorageSession(session);
      const loaded = await loadProject(saved.document, loadedSession);
      expect(loaded.project.assets[0]).toMatchObject({ kind: "image", width: 64, height: 48 });
      expect(loaded.project.clips).toEqual(project.clips);
      expect(loaded.project.playheadSec).toBe(0);
    } finally {
      await deleteProject(revisionId);
      await releaseStorageSession(loadedSession);
      await releaseStorageSession(session);
    }
  },
  30000,
);

it.skipIf(!real)("real ffmpeg: a video cannot be imported as an image with its original valid fingerprint", async () => {
  const id = randomUUID(), session = randomUUID(), loadedSession = randomUUID();
  const revisionId = randomUUID();
  await reserveStorage([{ id, kind: "uploads" }], session);
  const dir = path.join(UPLOADS_ROOT, id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "input.mp4");
  execFileSync(process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=64x48:r=30:d=1", "-c:v", "libx264", file,
  ]);
  await expect(probeImage(file)).rejects.toThrow(/画像形式/);
  const project = createEmptyProject();
  project.assets = [{ id, kind: "video", ext: "mp4", displayName: "video", streamUrl: "/ignored", width: 64, height: 48, sourceDurationSec: 1 }];
  try {
    const saved = await saveProject(revisionId, projectDocumentDraft(project));
    const forged = structuredClone(saved.document);
    forged.project.assets[0].kind = "image";
    forged.project.assets[0].ext = "png";
    delete forged.project.assets[0].sourceDurationSec;
    await expect(loadProject(forged, loadedSession)).rejects.toThrow(/形式|種類/);
  } finally {
    await deleteProject(revisionId);
    await releaseStorageSession(loadedSession);
    await releaseStorageSession(session);
  }
}, 30000);
