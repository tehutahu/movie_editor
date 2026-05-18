import { NextResponse } from "next/server";
import { buildFileStreamResponse } from "@/lib/fileStream";
import { findUploadInputPath } from "@/lib/storage";
import { assertUploadFileBelongsToVideo } from "@/lib/pathGuard";

export const runtime = "nodejs";

/** HTML5 の `<video>` 用ストリーム（簡易Range対応） */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ videoId: string }> },
) {
  try {
    const { videoId } = await ctx.params;
    const inputPath = await findUploadInputPath(videoId);
    if (!inputPath) {
      return NextResponse.json({ error: "動画が見つかりません。" }, { status: 404 });
    }
    assertUploadFileBelongsToVideo(videoId, inputPath);
    return await buildFileStreamResponse(inputPath, req);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
