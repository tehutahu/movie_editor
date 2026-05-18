import { NextResponse } from "next/server";
import { getJobRecord } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await ctx.params;
  const job = getJobRecord(jobId);
  if (!job) {
    return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  }

  return NextResponse.json({
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    createdAtMs: job.createdAtMs,
    downloadName: job.downloadName,
    error: job.error,
    hasOutput: Boolean(job.outputPath),
  });
}
