import { parseDownloadFilenameParam } from "@/lib/exportName";
import { getJobRecord } from "@/lib/jobs";
import { buildFileStreamResponse } from "@/lib/fileStream";
import { assertJobOutputFile } from "@/lib/pathGuard";
import { assertStorageId } from "@/lib/validation";

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
  try {
    assertStorageId("jobId", jobId);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
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

    const url = new URL(req.url);
    const override = parseDownloadFilenameParam(url.searchParams.get("downloadName"));
    const name = override ?? job.downloadName ?? "output.mp4";
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
