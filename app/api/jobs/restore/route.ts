import path from "node:path";
import { NextResponse } from "next/server";
import { assertFfmpegAvailable, restoreSpeedSameAsShell } from "@/lib/ffmpeg";
import {
  createJobRecord,
  patchJobRecord,
  runDetached,
} from "@/lib/jobs";
import { assertJobOutputFile } from "@/lib/pathGuard";
import { resolveInputPath } from "@/lib/mediaSource";
import { ensureJobDir, pruneJobsAfterComplete } from "@/lib/storage";
import { buildDownloadFilename, sanitizeExportBaseName } from "@/lib/exportName";
import {
  assertPositiveInt,
  assertPositiveNumber,
  assertStorageId,
  parseExportBaseName,
} from "@/lib/validation";

export const runtime = "nodejs";

type Body = {
  videoId?: string;
  /** 指定時はこのジョブの成果ファイルを入力にします（完了済みのみ）。 */
  sourceJobId?: string;
  speedFactor?: number;
  sampleRateHz?: number;
  /** 出力ファイル名のベース（任意）。 */
  exportBaseName?: string;
};

/** `restore_speed.sh` 相当フィルタで速度・音程を戻します。 */
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

    const speedFactor = assertPositiveNumber("speedFactor", body.speedFactor);
    const sampleRateHz = assertPositiveInt("sampleRateHz", body.sampleRateHz);

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

    const exportBase = sanitizeExportBaseName(
      parseExportBaseName(body.exportBaseName) ?? "video",
    );
    const job = createJobRecord("restore");
    patchJobRecord(job.id, {
      downloadName: buildDownloadFilename(
        exportBase,
        `restored_${speedFactor}x_${sampleRateHz}hz`,
        "mp4",
      ),
      currentStep: "restore",
    });

    runDetached(job.id, async () => {
      const jobDirAbs = await ensureJobDir(job.id);
      const outAbs = path.join(jobDirAbs, "output_restored.mp4");
      await restoreSpeedSameAsShell({
        inputPath,
        outputPath: outAbs,
        speedFactor,
        sampleRateHz,
        onProgress: (p) => patchJobRecord(job.id, {
          currentStep: "restore",
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
      { status: 400 },
    );
  }
}
