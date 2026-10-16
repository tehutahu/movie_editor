import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEmptyProject, clipFromAsset } from "./editor/project";
import { projectDocumentDraft } from "./editor/projectDocument";
import { probeVideo } from "./ffmpeg";
import { saveProject, loadProject, readProject, deleteProject } from "./projectStorage";
import { reserveStorage, releaseStorageSession } from "./storageRetention";
import { UPLOADS_ROOT } from "./paths";
import { GET as metadataGET } from "@/app/api/assets/[assetId]/metadata/route";

const real = process.env.RUN_FFMPEG_TESTS === "1";
const ffmpeg = process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg";
const ff = (args: string[]) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args]);
it.skipIf(!real).each([0, 90, 180, 270])(
  "real rotation %s: new display and old raw v1 save/load/import/relink preserve layout and reject forged media",
  async (rotation) => {
    const session = randomUUID(), loadedSession = randomUUID(), id = randomUUID();
    const replacement = randomUUID(), different = randomUUID();
    const versions: string[] = [];
    await reserveStorage([id, replacement, different].map(id => ({ id, kind: "uploads" as const })), session);
    const dir = path.join(UPLOADS_ROOT, id);
    await mkdir(dir, { recursive: true });
    const base = path.join(dir, "base.mp4"), input = path.join(dir, "input.mp4");
    ff(["-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", base]);
    const hasDisplayOption = execFileSync(ffmpeg, ["-h", "full"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).includes("-display_rotation");
    ff(hasDisplayOption
      ? ["-display_rotation", String(rotation), "-i", base, "-c", "copy", input]
      : ["-i", base, "-c", "copy", "-metadata:s:v:0", `rotate=${rotation}`, input]);
    const inputProbe = JSON.parse(execFileSync(process.env.FFPROBE_PATH ?? "/usr/bin/ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", input], { encoding: "utf8" }));
    const matrix = inputProbe.streams[0].side_data_list?.find(
      (data: { side_data_type?: string }) => data.side_data_type === "Display Matrix",
    );
    expect(((matrix?.rotation ?? 0) % 360 + 360) % 360).toBe(rotation);
    const bytes = await readFile(input);
    const changedBytes = Buffer.from(bytes); changedBytes[changedBytes.length - 1] ^= 1;
    for (const [ref, data] of [[replacement, bytes], [different, changedBytes]] as const) {
      await mkdir(path.join(UPLOADS_ROOT, ref), { recursive: true });
      await writeFile(path.join(UPLOADS_ROOT, ref, "input.mp4"), data);
    }
    try {
      const meta = await probeVideo(input);
      const swapped = rotation === 90 || rotation === 270;
      expect(meta).toMatchObject({ width: 320, height: 180,
        displayWidth: swapped ? 180 : 320, displayHeight: swapped ? 320 : 180 });
      const metadata = await metadataGET(new Request("http://localhost/api/assets/metadata"), { params: Promise.resolve({ assetId: id }) });
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({ width: meta.displayWidth, height: meta.displayHeight });
      for (const legacy of [true, false]) {
        const p = createEmptyProject();
        p.assets = [{ id, kind: "video", ext: "mp4", displayName: "rotated", streamUrl: "/ignored", sourceDurationSec: 1,
          width: legacy ? meta.width : meta.displayWidth, height: legacy ? meta.height : meta.displayHeight }];
        p.clips = [clipFromAsset({ asset: p.assets[0], trackId: p.tracks[0].id, timelineStartSec: 2 })];
        p.clips[0].transform = { x: 0.3, y: 0.7, scale: 1.2 };
        // Existing composition and transform must survive even if their aspect differs from the display.
        p.compositionWidth = 640; p.compositionHeight = 360;
        const revision = await saveProject(randomUUID(), projectDocumentDraft(p)); versions.push(revision.id);
        for (const doc of [await readProject(revision.id), JSON.parse(JSON.stringify(revision.document))]) {
          for (const replacements of [{}, { [id]: replacement }]) {
            const result = await loadProject(doc, loadedSession, replacements);
            expect(result.project).toMatchObject({ compositionWidth: 640, compositionHeight: 360, clips: p.clips });
            expect(result.project.assets[0]).toMatchObject({ width: p.assets[0].width, height: p.assets[0].height });
          }
          await expect(loadProject(doc, loadedSession, { [id]: different })).rejects.toThrow(/再指定/);
        }
        const wrongSize = structuredClone(revision.document); wrongSize.project.assets[0].media.size++;
        await expect(loadProject(wrongSize, loadedSession)).rejects.toThrow(/再指定/);
        const wrongPair = structuredClone(revision.document);
        wrongPair.project.assets[0].width = 180; wrongPair.project.assets[0].height = 180;
        await expect(loadProject(wrongPair, loadedSession)).rejects.toThrow(/メタデータ/);
        const wrongKind = structuredClone(revision.document);
        wrongKind.project.assets[0].kind = "image"; wrongKind.project.assets[0].ext = "png";
        delete wrongKind.project.assets[0].sourceDurationSec;
        await expect(loadProject(wrongKind, loadedSession)).rejects.toThrow(/種類/);
        const wrongDuration = structuredClone(revision.document); wrongDuration.project.assets[0].sourceDurationSec = 2;
        await expect(loadProject(wrongDuration, loadedSession)).rejects.toThrow(/メタデータ/);
        const wrongInterval = structuredClone(revision.document); wrongInterval.project.clips[0].parts[0].sourceOutSec = 2;
        await expect(loadProject(wrongInterval, loadedSession)).rejects.toThrow();
      }
    } finally {
      for (const version of versions) await deleteProject(version);
      await releaseStorageSession(loadedSession); await releaseStorageSession(session);
    }
  }, 30000,
);
