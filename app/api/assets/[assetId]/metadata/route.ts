import { NextResponse } from "next/server";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import { assertFfmpegAvailable, probeVideo } from "@/lib/ffmpeg";
import { getMediaStorage } from "@/lib/storage";
import { assertStorageId } from "@/lib/validation";

export const runtime = "nodejs";

type Params = { params: Promise<{ assetId: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    await assertFfmpegAvailable();
    const { assetId } = await params;
    assertStorageId("assetId", assetId);

    const storage = getMediaStorage();
    const inputPath = await resolveAssetInputPath(assetId);
    if (!inputPath) {
      return NextResponse.json({ error: "素材が見つかりません。" }, { status: 404 });
    }

    const displayName = (await storage.readDisplayName(assetId)) ?? assetId;
    const ext = inputPath.split(".").pop()?.toLowerCase() ?? "";
    const isImage = ["png", "jpg", "jpeg", "webp", "gif"].includes(ext);

    if (isImage) {
      const probe = await probeVideo(inputPath).catch(() => null);
      return NextResponse.json({
        assetId,
        kind: "image",
        displayName,
        width: probe?.width,
        height: probe?.height,
        hasAudio: false,
        hasVideo: false,
        durationSec: undefined,
        thumbnailStripUrl: storage.thumbnailStripUrl(assetId),
      });
    }

    const probe = await probeVideo(inputPath);
    return NextResponse.json({
      assetId,
      kind: "video",
      displayName,
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      hasVideo: probe.hasVideo,
      thumbnailStripUrl: storage.thumbnailStripUrl(assetId),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
