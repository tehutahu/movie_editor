import { NextResponse } from "next/server";
import { displayNameFromOriginalFilename } from "@/lib/exportName";
import { assertFfmpegAvailable, probeVideo } from "@/lib/ffmpeg";
import { createJobRecord, patchJobRecord, runDetached } from "@/lib/jobs";
import { generateFilmstrip } from "@/lib/ffmpeg";
import { getMediaStorage } from "@/lib/storage";
import {
  ensureStorageTrees,
  newVideoId,
  pruneUploadsAfterSave,
} from "@/lib/storage";
import {
  MAX_UPLOAD_BYTES,
  parseAllowedAssetExtension,
} from "@/lib/validation";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureJobDir } from "@/lib/storage";

export const runtime = "nodejs";

async function runThumbnailJob(assetId: string, inputPath: string, durationSec: number) {
  const job = createJobRecord("thumbnails", { assetId });
  runDetached(job.id, async () => {
    patchJobRecord(job.id, { currentStep: "filmstrip" });
    const storage = getMediaStorage();
    const tmpDir = await ensureJobDir(job.id);
    const tmpStrip = path.join(tmpDir, "filmstrip.jpg");
    await generateFilmstrip({
      inputPath,
      outputPath: tmpStrip,
      durationSec,
    });
    const bytes = new Uint8Array(await readFile(tmpStrip));
    await storage.saveThumbnailStrip(assetId, bytes);
    patchJobRecord(job.id, { outputPath: tmpStrip, currentStep: "done" });
  });
  return job.id;
}

/** Upload one or more assets (video/image). FormData: `file` or multiple `files`. */
export async function POST(req: Request) {
  try {
    await ensureStorageTrees();
    await assertFfmpegAvailable();

    const form = await req.formData();
    const files: File[] = [];
    const single = form.get("file");
    if (single instanceof File) files.push(single);
    for (const f of form.getAll("files")) {
      if (f instanceof File) files.push(f);
    }

    if (files.length === 0) {
      return NextResponse.json({ error: "file または files が必要です。" }, { status: 400 });
    }

    const storage = getMediaStorage();
    const results: {
      assetId: string;
      kind: string;
      ext: string;
      displayName: string;
      streamUrl: string;
      thumbnailStripUrl?: string;
      sourceDurationSec?: number;
      width?: number;
      height?: number;
      thumbnailJobId?: string;
    }[] = [];

    for (const file of files) {
      const parsed = parseAllowedAssetExtension(file.name);
      if (!parsed) {
        return NextResponse.json(
          { error: `未対応の拡張子: ${file.name}` },
          { status: 400 },
        );
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: `ファイルサイズが上限を超えています: ${file.name}` },
          { status: 413 },
        );
      }

      const buf = new Uint8Array(await file.arrayBuffer());
      const assetId = newVideoId();
      const displayName = displayNameFromOriginalFilename(file.name);

      await storage.saveAsset({
        assetId,
        ext: parsed.ext,
        bytes: buf,
        displayName,
        kind: parsed.kind,
      });

      let sourceDurationSec: number | undefined;
      let width: number | undefined;
      let height: number | undefined;
      let thumbnailJobId: string | undefined;

      const inputPath = await storage.findInputPath(assetId);
      if (inputPath && parsed.kind === "video") {
        const probe = await probeVideo(inputPath);
        sourceDurationSec = probe.durationSec;
        width = probe.width;
        height = probe.height;
        thumbnailJobId = await runThumbnailJob(assetId, inputPath, probe.durationSec);
      } else if (inputPath && parsed.kind === "image") {
        const probe = await probeVideo(inputPath).catch(() => null);
        width = probe?.width;
        height = probe?.height;
      }

      await pruneUploadsAfterSave(assetId);

      results.push({
        assetId,
        kind: parsed.kind,
        ext: parsed.ext,
        displayName,
        streamUrl: storage.streamUrl(assetId),
        thumbnailStripUrl: storage.thumbnailStripUrl(assetId),
        sourceDurationSec,
        width,
        height,
        thumbnailJobId,
      });
    }

    return NextResponse.json({ assets: results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
