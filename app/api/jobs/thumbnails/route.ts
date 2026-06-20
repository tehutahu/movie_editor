import { NextResponse } from "next/server";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import { assertFfmpegAvailable, generateFilmstrip, probeVideo } from "@/lib/ffmpeg";
import { createJobRecord, patchJobRecord, runDetached } from "@/lib/jobs";
import { getMediaStorage } from "@/lib/storage";
import { ensureJobDir } from "@/lib/storage";
import { assertStorageId } from "@/lib/validation";
import path from "node:path";
import { readFile } from "node:fs/promises";

export const runtime = "nodejs";

/** Generate filmstrip thumbnails for an asset (video). */
export async function POST(req: Request) {
  try {
    await assertFfmpegAvailable();
    const body = (await req.json()) as { assetId?: string };
    if (!body.assetId) {
      return NextResponse.json({ error: "assetId が必要です。" }, { status: 400 });
    }
    assertStorageId("assetId", body.assetId);

    const inputPath = await resolveAssetInputPath(body.assetId);
    if (!inputPath) {
      return NextResponse.json({ error: "素材が見つかりません。" }, { status: 404 });
    }

    const probe = await probeVideo(inputPath);
    const job = createJobRecord("thumbnails", { assetId: body.assetId });
    const storage = getMediaStorage();

    runDetached(job.id, async () => {
      patchJobRecord(job.id, { currentStep: "filmstrip" });
      const jobDir = await ensureJobDir(job.id);
      const tmpStrip = path.join(jobDir, "filmstrip.jpg");
      await generateFilmstrip({
        inputPath,
        outputPath: tmpStrip,
        durationSec: probe.durationSec,
      });
      const bytes = new Uint8Array(await readFile(tmpStrip));
      await storage.saveThumbnailStrip(body.assetId!, bytes);
      patchJobRecord(job.id, { outputPath: tmpStrip, currentStep: "done" });
    });

    return NextResponse.json({ jobId: job.id });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
