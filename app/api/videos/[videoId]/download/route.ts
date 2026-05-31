import path from "node:path";
import { NextResponse } from "next/server";
import {
  buildDownloadFilename,
  parseDownloadFilenameParam,
  sanitizeExportBaseName,
} from "@/lib/exportName";
import { buildFileStreamResponse } from "@/lib/fileStream";
import { findUploadInputPath, readUploadDisplayName } from "@/lib/storage";
import { assertUploadFileBelongsToVideo } from "@/lib/pathGuard";
import { assertStorageId } from "@/lib/validation";

export const runtime = "nodejs";

function contentDispositionAttachment(name: string): string {
  const safeAscii = name.replace(/[\r\n"]/g, "_");
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function resolveUploadDownloadName(
  req: Request,
  videoId: string,
  inputPath: string,
): Promise<string> {
  const url = new URL(req.url);
  const override = parseDownloadFilenameParam(url.searchParams.get("downloadName"));
  if (override) return Promise.resolve(override);

  return readUploadDisplayName(videoId).then((stored) => {
    const ext = path.extname(inputPath).replace(/^\./, "") || "mp4";
    const base = sanitizeExportBaseName(stored ?? "video");
    return buildDownloadFilename(base, "", ext);
  });
}

/** アップロード済みオリジナル動画を添付ダウンロードします（未編集エクスポート用）。 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ videoId: string }> },
) {
  try {
    const { videoId } = await ctx.params;
    assertStorageId("videoId", videoId);
    const inputPath = await findUploadInputPath(videoId);
    if (!inputPath) {
      return NextResponse.json({ error: "動画が見つかりません。" }, { status: 404 });
    }
    assertUploadFileBelongsToVideo(videoId, inputPath);

    const res = await buildFileStreamResponse(inputPath, req);
    const downloadName = await resolveUploadDownloadName(req, videoId, inputPath);
    const headers = new Headers(res.headers);
    headers.set("Content-Disposition", contentDispositionAttachment(downloadName));

    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
