import path from "node:path";
import { NextResponse } from "next/server";
import { assertFfmpegAvailable, restoreSpeedSameAsShell } from "@/lib/ffmpeg";
import {
  createJobRecord,
  patchJobRecord,
  runDetached,
} from "@/lib/jobs";
import { assertJobOutputFile, assertUploadFileBelongsToVideo } from "@/lib/pathGuard";
import { ensureJobDir, findUploadInputPath } from "@/lib/storage";
import { assertPositiveInt, assertPositiveNumber } from "@/lib/validation";

export const runtime = "nodejs";

type Body = {
  videoId?: string;
  speedFactor?: number;
  sampleRateHz?: number;
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

    const videoId = typeof body.videoId === "string" ? body.videoId : "";
    if (!videoId) {
      return NextResponse.json({ error: "videoId が必要です。" }, { status: 400 });
    }

    const speedFactor = assertPositiveNumber("speedFactor", body.speedFactor);
    const sampleRateHz = assertPositiveInt("sampleRateHz", body.sampleRateHz);

    const inputPath = await findUploadInputPath(videoId);
    if (!inputPath) {
      return NextResponse.json({ error: "動画が見つかりません。" }, { status: 404 });
    }
    assertUploadFileBelongsToVideo(videoId, inputPath);

    const job = createJobRecord("restore");
    patchJobRecord(job.id, {
      downloadName: `restored_${speedFactor}x_${sampleRateHz}hz.mp4`,
    });

    runDetached(job.id, async () => {
      const jobDirAbs = await ensureJobDir(job.id);
      const outAbs = path.join(jobDirAbs, "output_restored.mp4");
      await restoreSpeedSameAsShell({
        inputPath,
        outputPath: outAbs,
        speedFactor,
        sampleRateHz,
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
