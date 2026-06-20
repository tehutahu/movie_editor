import { NextResponse } from "next/server";
import { buildDownloadFilename, sanitizeExportBaseName } from "@/lib/exportName";
import { exportCompositionToFile } from "@/lib/exportComposition";
import { parseCompositionExportPayload } from "@/lib/editor/validateExportProject";
import { assertFfmpegAvailable } from "@/lib/ffmpeg";
import { createJobRecord, patchJobRecord, runDetached } from "@/lib/jobs";
import { ensureJobDir, pruneJobsAfterComplete } from "@/lib/storage";
import path from "node:path";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    await assertFfmpegAvailable();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "JSON body が不正です。" }, { status: 400 });
    }

    const parsed = parseCompositionExportPayload(body);
    const baseName = sanitizeExportBaseName(parsed.exportBaseName ?? "project");
    const job = createJobRecord("export_composition");
    const jobDir = await ensureJobDir(job.id);
    const outputPath = path.join(jobDir, "output_composition.mp4");
    const downloadName = buildDownloadFilename(baseName, "export", "mp4");

    runDetached(job.id, async () => {
      patchJobRecord(job.id, { currentStep: "export" });
      await exportCompositionToFile({
        project: { ...parsed.project, exportBaseName: baseName },
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
      { status: 400 },
    );
  }
}
