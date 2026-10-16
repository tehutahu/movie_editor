import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { probeVideo, restoreSpeedSameAsShell } from "@/lib/ffmpeg";
import { createJobRecord } from "@/lib/jobs";
import { loadProject, readProject, saveProject, deleteProject } from "@/lib/projectStorage";
import { reserveStorage, releaseStorageSession } from "@/lib/storageRetention";
import { UPLOADS_ROOT, JOBS_ROOT } from "@/lib/paths";
import { createEmptyProject, clipFromAsset } from "./project";
import { projectDocumentDraft } from "./projectDocument";
import { createCommandHistory, dispatchCommand, undo, redo, getCurrentProject } from "./commandHistory";
import { parseRestoreResultMetadata } from "./restoreResult";
const real = process.env.RUN_FFMPEG_TESTS === "1";
it.skipIf(!real).each([0, 90, 180, 270])("real restore %s: adopts output dimensions, saves under unchanged validation, and preserves the immutable original", async (rotation) => {
  const session = randomUUID(), loadedSession = randomUUID(), id = randomUUID(), jobId = randomUUID();
  const versions: string[] = [];
  await reserveStorage([{ id, kind: "uploads" }, { id: jobId, kind: "jobs" }], session);
  const dir = path.join(UPLOADS_ROOT, id), jobDir = path.join(JOBS_ROOT, jobId);
  await mkdir(dir, { recursive: true }); await mkdir(jobDir, { recursive: true });
  const base = path.join(dir, "base.mp4"), input = path.join(dir, "input.mp4"), output = path.join(jobDir, "output_restored.mp4");
  const ffmpeg = process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg";
  const ff = (args: string[]) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args]);
  ff(["-f", "lavfi", "-i", "color=red:s=160x90:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", base]);
  const displayOption = execFileSync(ffmpeg, ["-h", "full"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).includes("-display_rotation");
  ff(displayOption ? ["-display_rotation", String(rotation), "-i", base, "-c", "copy", input]
    : ["-i", base, "-c", "copy", "-metadata:s:v:0", `rotate=${rotation}`, input]);
  const json = JSON.parse(execFileSync(process.env.FFPROBE_PATH ?? "/usr/bin/ffprobe",
    ["-v", "error", "-show_streams", "-of", "json", input], { encoding: "utf8" }));
  const matrix = json.streams[0].side_data_list?.find((d: { side_data_type?: string }) => d.side_data_type === "Display Matrix");
  expect(((matrix?.rotation ?? 0) % 360 + 360) % 360).toBe(rotation);
  try {
    const source = await probeVideo(input), p = createEmptyProject();
    p.compositionWidth = 640; p.compositionHeight = 360;
    p.assets = [{ id, kind: "video", ext: "mp4", displayName: "legacy raw", streamUrl: "/source",
      sourceDurationSec: source.durationSec, width: 160, height: 90 }];
    p.clips = [clipFromAsset({ asset: p.assets[0], trackId: p.tracks[0].id, timelineStartSec: 1, durationSec: 1 })];
    const old = await saveProject(randomUUID(), projectDocumentDraft(p)); versions.push(old.id);
    await restoreSpeedSameAsShell({ inputPath: input, outputPath: output, speedFactor: 2, sampleRateHz: 44100 });
    const restored = await probeVideo(output);
    expect([restored.width, restored.height]).toEqual(rotation === 90 || rotation === 270 ? [90, 160] : [160, 90]);
    createJobRecord("restore", { id: jobId, status: "done", outputPath: output });
    const result = dispatchCommand(createCommandHistory(p), { type: "restoreSpeed", assetId: id, jobId, speedFactor: 2,
      ...parseRestoreResultMetadata({ jobId, hasVideo: restored.hasVideo, durationSec: restored.durationSec,
        width: restored.width, height: restored.height }, jobId) })!;
    const after = await saveProject(randomUUID(), projectDocumentDraft(result.project)); versions.push(after.id);
    const loaded = await loadProject(after.document, loadedSession);
    expect(loaded.project.assets[0]).toMatchObject({ width: restored.width, height: restored.height, sourceJobId: jobId });
    expect(loaded.project).toMatchObject({ compositionWidth: 640, compositionHeight: 360, clips: result.project.clips });
    expect(await readProject(old.id)).toEqual(old.document);
    const undone = getCurrentProject(undo(result.history)!);
    expect(undone).toEqual(p);
    const undoVersion = await saveProject(randomUUID(), projectDocumentDraft(undone)); versions.push(undoVersion.id);
    expect(getCurrentProject(redo(undo(result.history)!)!)).toEqual(result.project);
  } finally {
    for (const id of versions) await deleteProject(id);
    await releaseStorageSession(loadedSession); await releaseStorageSession(session);
  }
}, 30000);
