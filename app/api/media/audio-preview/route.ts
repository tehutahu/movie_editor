import { parseAsset } from "@/lib/editor/validateExportProject";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import { negativeMkvPreviewAudio } from "@/lib/negativeMkvAudio";
export const runtime = "nodejs";
/** An optional, bounded preview derivative; never a replacement stream URL. */
export async function POST(req: Request) {
  try {
    const text = await req.text();
    if (text.length > 128 * 1024) return new Response(null, { status: 400 });
    const asset = parseAsset(JSON.parse(text).asset, 0);
    const file = asset.kind === "video" && asset.ext === "mkv" && !asset.sourceJobId ? await resolveAssetInputPath(asset) : null;
    const audio = file ? await negativeMkvPreviewAudio(file) : null;
    return audio ? new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/mp4", "Content-Length": String(audio.length), "Cache-Control": "no-store" } }) : new Response(null, { status: 204 });
  } catch { return new Response(null, { status: 400 }); }
}
