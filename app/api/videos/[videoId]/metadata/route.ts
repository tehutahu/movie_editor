import { NextResponse } from "next/server";
import { assertFfmpegAvailable, probeVideo } from "@/lib/ffmpeg";
import { findUploadInputPath, readUploadDisplayName } from "@/lib/storage";
import { assertUploadFileBelongsToVideo } from "@/lib/pathGuard";
import { assertStorageId } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ videoId: string }> },
) {
  try {
    await assertFfmpegAvailable();
    const { videoId } = await ctx.params;
    assertStorageId("videoId", videoId);
    const inputPath = await findUploadInputPath(videoId);
    if (!inputPath) {
      return NextResponse.json({ error: "動画が見つかりません。" }, { status: 404 });
    }
    assertUploadFileBelongsToVideo(videoId, inputPath);

    const info = await probeVideo(inputPath);
    const displayName = await readUploadDisplayName(videoId);
    return NextResponse.json({
      videoId,
      displayName: displayName ?? undefined,
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
