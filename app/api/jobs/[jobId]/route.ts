import { NextResponse } from "next/server";
import { getJobRecord } from "@/lib/jobs";
import { assertStorageId } from "@/lib/validation";

export const runtime = "nodejs";

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

  return NextResponse.json({
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    createdAtMs: job.createdAtMs,
    downloadName: job.downloadName,
    error: job.error,
    progressPct: job.progressPct,
    etaSec: job.etaSec,
    currentStep: job.currentStep,
    hasOutput: Boolean(job.outputPath),
  });
}
