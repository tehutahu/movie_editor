import { NextResponse } from "next/server";
import { probeVideo } from "@/lib/ffmpeg";
import { getJobRecord } from "@/lib/jobs";
import { assertJobOutputFile } from "@/lib/pathGuard";
import { assertStorageId } from "@/lib/validation";

export const runtime = "nodejs";

/** ジョブ成果ファイルの長さなど（タイムライン用）を返します。 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await ctx.params;
  try {
    assertStorageId("jobId", jobId);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const job = getJobRecord(jobId);
  if (!job) {
    return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  }
  if (job.status !== "done" || !job.outputPath) {
    return NextResponse.json(
      { error: "成果ファイルがまだありません（ジョブ状態を確認してください）。" },
      { status: 409 },
    );
  }

  try {
    assertJobOutputFile(jobId, job.outputPath);
    const meta = await probeVideo(job.outputPath);
    return NextResponse.json({
      jobId,
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
      hasVideo: meta.hasVideo,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
