import { NextResponse } from "next/server";
import { parseAsset } from "@/lib/editor/validateExportProject";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import { inspectMediaLayout, MediaLayoutError } from "@/lib/mediaLayout";
export const runtime = "nodejs";
/** Read-only actual-media eligibility. Paths/URLs supplied by clients are ignored. */
export async function POST(req: Request) {
  try {
    const raw = await req.text();
    if (raw.length > 128 * 1024) throw new Error("リクエストが大きすぎます。");
    const body = JSON.parse(raw);
    if (!Array.isArray(body.assets) || !body.assets.length || body.assets.length > 50) throw new Error("素材件数が不正です。");
    const result = [];
    for (const [i, raw] of body.assets.entries()) {
      const a = parseAsset(raw, i);
      const input = await resolveAssetInputPath(a);
      if (!input) throw new MediaLayoutError("LAYOUT_MEDIA_MISSING", "素材が見つかりません。再リンクしてください。");
      result.push({ id: a.id, ...await inspectMediaLayout(input, a.kind, a.ext), eligible: true });
    }
    return NextResponse.json({ assets: result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), code: e instanceof MediaLayoutError ? e.code : "INVALID_LAYOUT_REQUEST" }, { status: e instanceof MediaLayoutError ? 422 : 400 });
  }
}
