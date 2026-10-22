import { StorageRetentionError } from "@/lib/storageRetention";
import path from "node:path";
import { NextResponse } from "next/server";
import { assertFfmpegAvailable, probeVideo } from "@/lib/ffmpeg";
import { extractEditorSegment } from "@/lib/sourceAvClock";
import {
  createRetainedJobRecord,
  patchJobRecord,
  runDetached,
} from "@/lib/jobs";
import { assertJobOutputFile } from "@/lib/pathGuard";
import { resolveInputPath } from "@/lib/mediaSource";
import { ensureJobDir, pruneJobsAfterComplete } from "@/lib/storage";
import { buildDownloadFilename, sanitizeExportBaseName } from "@/lib/exportName";
import {
  assertStorageId,
  normalizeRanges,
  parseExportBaseName,
} from "@/lib/validation";

export const runtime = "nodejs";

type Body = {
  videoId?: string;
  editorSessionId?: string;
  sourceJobId?: string;
  startSec?: number;
  endSec?: number;
  exportBaseName?: string;
};

/** 指定区間を単体ファイルとして書き出します。 */
export async function POST(req: Request) {
  try {
    await assertFfmpegAvailable();
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ error: "JSON body が不正です。" }, { status: 400 });
    }

    const videoIdRaw = typeof body.videoId === "string" ? body.videoId : "";
    if (!videoIdRaw) {
      return NextResponse.json({ error: "videoId が必要です。" }, { status: 400 });
    }
    const videoId = assertStorageId("videoId", videoIdRaw);

    let inputPath: string;
    try {
      const resolved = await resolveInputPath({
        videoId,
        sourceJobId: body.sourceJobId,
      });
      inputPath = resolved.inputPath;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes("見つかりません") ? 404 : 400;
      return NextResponse.json({ error: msg }, { status });
    }

    const meta = await probeVideo(inputPath);
    const [range] = normalizeRanges(meta.durationSec, [
      { startSec: body.startSec, endSec: body.endSec },
    ]);

    const exportBase = sanitizeExportBaseName(
      parseExportBaseName(body.exportBaseName) ?? "video",
    );
    const job = await createRetainedJobRecord("export_segment", {
      sessionId: body.editorSessionId,
      dependencies: [videoId, ...(body.sourceJobId ? [body.sourceJobId] : [])],
    });
    patchJobRecord(job.id, {
      downloadName: buildDownloadFilename(
        exportBase,
        `segment_${range.startSec}-${range.endSec}`,
        "mp4",
      ),
      currentStep: "segment",
    });

    runDetached(job.id, async () => {
      const jobDirAbs = await ensureJobDir(job.id);
      const outAbs = path.join(jobDirAbs, "output_segment.mp4");
      await extractEditorSegment({
        inputPath,
        outputPath: outAbs,
        startSec: range.startSec,
        endSec: range.endSec,
        onProgress: (p) => patchJobRecord(job.id, {
          currentStep: "segment",
          progressPct: p.progressPct,
          etaSec: p.etaSec,
        }),
      });
      assertJobOutputFile(job.id, outAbs);
      patchJobRecord(job.id, { outputPath: outAbs });
      await pruneJobsAfterComplete(job.id);
    });

    return NextResponse.json({ jobId: job.id });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: e instanceof StorageRetentionError ? e.status : 400 },
    );
  }
}
