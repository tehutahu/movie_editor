import path from "node:path";
import { NextResponse } from "next/server";
import { assertFfmpegAvailable, extractSegmentTimes, probeVideo } from "@/lib/ffmpeg";
import {
  createJobRecord,
  patchJobRecord,
  runDetached,
} from "@/lib/jobs";
import { assertJobOutputFile, assertUploadFileBelongsToVideo } from "@/lib/pathGuard";
import { ensureJobDir, findUploadInputPath } from "@/lib/storage";
import { assertStorageId, normalizeRanges } from "@/lib/validation";

export const runtime = "nodejs";

type Body = {
  videoId?: string;
  startSec?: number;
  endSec?: number;
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

    const inputPath = await findUploadInputPath(videoId);
    if (!inputPath) {
      return NextResponse.json({ error: "動画が見つかりません。" }, { status: 404 });
    }
    assertUploadFileBelongsToVideo(videoId, inputPath);

    const meta = await probeVideo(inputPath);
    const [range] = normalizeRanges(meta.durationSec, [
      { startSec: body.startSec, endSec: body.endSec },
    ]);

    const job = createJobRecord("export_segment");
    patchJobRecord(job.id, {
      downloadName: `segment_${range.startSec}-${range.endSec}.mp4`,
      currentStep: "segment",
    });

    runDetached(job.id, async () => {
      const jobDirAbs = await ensureJobDir(job.id);
      const outAbs = path.join(jobDirAbs, "output_segment.mp4");
      await extractSegmentTimes({
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
    });

    return NextResponse.json({ jobId: job.id });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
