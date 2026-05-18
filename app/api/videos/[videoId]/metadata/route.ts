import { NextResponse } from "next/server";
import { assertFfmpegAvailable, probeVideo } from "@/lib/ffmpeg";
import { findUploadInputPath } from "@/lib/storage";
import { assertUploadFileBelongsToVideo } from "@/lib/pathGuard";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ videoId: string }> },
) {
  try {
    await assertFfmpegAvailable();
    const { videoId } = await ctx.params;
    const inputPath = await findUploadInputPath(videoId);
    if (!inputPath) {
      return NextResponse.json({ error: "動画が見つかりません。" }, { status: 404 });
    }
    assertUploadFileBelongsToVideo(videoId, inputPath);

    const info = await probeVideo(inputPath);
    return NextResponse.json({
      videoId,
      durationSec: info.durationSec,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      hasVideo: info.hasVideo,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
