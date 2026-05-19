import { NextResponse } from "next/server";
import { buildFileStreamResponse } from "@/lib/fileStream";
import { findUploadInputPath } from "@/lib/storage";
import { assertUploadFileBelongsToVideo } from "@/lib/pathGuard";
import { assertStorageId } from "@/lib/validation";

export const runtime = "nodejs";

function contentDispositionAttachment(name: string): string {
  const safeAscii = name.replace(/[\r\n"]/g, "_");
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
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
    const base = inputPath.split(/[/\\]/).pop() ?? "upload.mp4";
    const headers = new Headers(res.headers);
    headers.set("Content-Disposition", contentDispositionAttachment(base));

    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
