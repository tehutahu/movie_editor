import { getJobRecord } from "@/lib/jobs";
import { buildFileStreamResponse } from "@/lib/fileStream";
import { assertJobOutputFile } from "@/lib/pathGuard";

export const runtime = "nodejs";

function contentDispositionAttachment(name: string): string {
  const safeAscii = name.replace(/[\r\n"]/g, "_");
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await ctx.params;
  const job = getJobRecord(jobId);
  if (!job) {
    return Response.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  }
  if (job.status !== "done" || !job.outputPath) {
    return Response.json(
      { error: "成果物がまだありません（ジョブ状態を確認してください）。" },
      { status: 409 },
    );
  }

  try {
    assertJobOutputFile(jobId, job.outputPath);
    const res = await buildFileStreamResponse(job.outputPath, req);

    const name = job.downloadName ?? "output.mp4";
    const headers = new Headers(res.headers);
    headers.set("Content-Disposition", contentDispositionAttachment(name));

    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
