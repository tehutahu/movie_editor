import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createEmptyProject } from "./editor/project";
import { projectDocumentDraft } from "./editor/projectDocument";
import { saveProject, loadProject, deleteProject } from "./projectStorage";
import { reserveStorage, releaseStorageSession } from "./storageRetention";
import { clearJobStoreForTests } from "./jobs";
import { exportCompositionToFile } from "./exportComposition";
import { probeVideo } from "./ffmpeg";
import { UPLOADS_ROOT, JOBS_ROOT } from "./paths";

const real = process.env.RUN_FFMPEG_TESTS === "1";
function ff(args: string[]) {
  return execFileSync(process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg", ["-v", "error", "-y", ...args]);
}
it.skipIf(!real)("saved joined clips preserve off-canvas placement, delayed video/audio and exclusive end after main integration", async () => {
  const assetId = randomUUID(), session = randomUUID(), loadedSession = randomUUID(), revisionId = randomUUID();
  await reserveStorage([{ id: assetId, kind: "uploads" }], session);
  const dir = path.join(UPLOADS_ROOT, assetId);
  const jobDir = path.join(JOBS_ROOT, randomUUID());
  await mkdir(dir, { recursive: true }); await mkdir(jobDir, { recursive: true });
  const input = path.join(dir, "input.mp4");
  ff(["-f", "lavfi", "-i", "color=red:s=320x320:r=30:d=1", "-f", "lavfi", "-i", "color=blue:s=320x320:r=30:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-c:a", "aac", "-t", "2", input]);
  const metadata = await probeVideo(input);
  const project = createEmptyProject();
  project.compositionWidth = 320; project.compositionHeight = 320; project.compositionDurationSec = 3;
  project.assets = [{ id: assetId, kind: "video", ext: "mp4", displayName: "red-blue", streamUrl: "/ignored", width: 320, height: 320, sourceDurationSec: metadata.durationSec }];
  project.clips = [{ id: randomUUID(), trackId: project.tracks[0].id, timelineStartSec: 1, durationSec: 1,
    parts: [{ assetId, sourceInSec: 0.2, sourceOutSec: 0.7 }, { assetId, sourceInSec: 1.2, sourceOutSec: 1.7 }],
    transform: { x: -0.1, y: 0.5, scale: 2 } }];
  try {
    const saved = await saveProject(revisionId, projectDocumentDraft(project));
    await releaseStorageSession(session); clearJobStoreForTests();
    const loaded = await loadProject(saved.document, loadedSession);
    expect(loaded.project.clips).toEqual(project.clips);
    const output = path.join(jobDir, "roundtrip.mp4");
    await exportCompositionToFile({ project: loaded.project, jobDir, outputPath: output });
    expect((await probeVideo(output)).durationSec).toBeCloseTo(3, 1);
    function pixel(time: number, x: number) {
      const rgb = ff(["-ss", String(time), "-i", output, "-frames:v", "1", "-vf", `crop=2:2:${x}:160,scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
      expect(rgb.length).toBe(3); return rgb;
    }
    expect(Math.max(...pixel(0.2, 60))).toBeLessThan(30);
    expect(pixel(1.2, 60)[0]).toBeGreaterThan(150);
    expect(pixel(1.7, 60)[2]).toBeGreaterThan(150);
    expect(Math.max(...pixel(1.2, 240))).toBeLessThan(30);
    expect(Math.max(...pixel(2, 60))).toBeLessThan(30);
    function audioPeak(time: number) {
      // Audio may end before the video; pad its full timeline before sampling.
      const pcm = ff(["-i", output, "-t", "3", "-vn", "-af", "apad", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
      const bytes = pcm.subarray(Math.round(time * 8000) * 4, Math.round((time + 0.1) * 8000) * 4);
      expect(bytes.length).toBeGreaterThan(1000);
      let peak = 0; for (let i = 0; i + 4 <= bytes.length; i += 4) peak = Math.max(peak, Math.abs(bytes.readFloatLE(i)));
      return peak;
    }
    expect(audioPeak(0.2)).toBeLessThan(0.001);
    expect(audioPeak(1.2)).toBeGreaterThan(0.01);
    expect(audioPeak(2.2)).toBeLessThan(0.001);
  } finally {
    await deleteProject(revisionId); await releaseStorageSession(loadedSession); await releaseStorageSession(session);
  }
}, 60000);
