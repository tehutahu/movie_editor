import { NextResponse } from "next/server";
import { buildDownloadFilename, sanitizeExportBaseName } from "@/lib/exportName";
import { exportCompositionToFile, type CompositionExportPayload } from "@/lib/exportComposition";
import { assertFfmpegAvailable } from "@/lib/ffmpeg";
import { createJobRecord, patchJobRecord, runDetached } from "@/lib/jobs";
import { ensureJobDir, pruneJobsAfterComplete } from "@/lib/storage";
import path from "node:path";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    await assertFfmpegAvailable();
    const body = (await req.json()) as CompositionExportPayload & { exportBaseName?: string };

    if (!body.clips?.length) {
      return NextResponse.json({ error: "クリップがありません。" }, { status: 400 });
    }

    const baseName = sanitizeExportBaseName(body.exportBaseName ?? "project");
    const job = createJobRecord("export_composition");
    const jobDir = await ensureJobDir(job.id);
    const outputPath = path.join(jobDir, "output_composition.mp4");
    const downloadName = buildDownloadFilename(baseName, "export", "mp4");

    runDetached(job.id, async () => {
      patchJobRecord(job.id, { currentStep: "export" });
      await exportCompositionToFile({
        project: {
          assets: body.assets ?? [],
          tracks: body.tracks ?? [],
          clips: body.clips,
          compositionDurationSec: body.compositionDurationSec ?? 30,
          playheadSec: 0,
          selectedClipIds: [],
          exportBaseName: baseName,
        },
        jobDir,
        outputPath,
        onProgress: (pct) => patchJobRecord(job.id, { progressPct: pct }),
      });
      patchJobRecord(job.id, { outputPath, downloadName, currentStep: "done" });
      await pruneJobsAfterComplete(job.id);
    });

    return NextResponse.json({ jobId: job.id });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
