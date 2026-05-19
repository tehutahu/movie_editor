import { NextResponse } from "next/server";
import { buildFileStreamResponse } from "@/lib/fileStream";
import { getJobRecord } from "@/lib/jobs";
import { assertJobOutputFile } from "@/lib/pathGuard";
import { assertStorageId } from "@/lib/validation";

export const runtime = "nodejs";

/** ジョブ成果ファイルの `<video src>` 用ストリーム（Range 対応） */
export async function GET(
  req: Request,
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
      { error: "成果物がまだありません（ジョブ状態を確認してください）。" },
      { status: 409 },
    );
  }

  try {
    assertJobOutputFile(jobId, job.outputPath);
    return await buildFileStreamResponse(job.outputPath, req);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
