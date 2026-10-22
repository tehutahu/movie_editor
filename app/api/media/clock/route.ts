import { NextResponse } from "next/server";
import { parseAsset } from "@/lib/editor/validateExportProject";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import { inspectSourceAvClock } from "@/lib/sourceAvClock";
export const runtime = "nodejs";
/** Actual local media only; caller paths, URLs and saved timing are ignored. */
export async function POST(req: Request) {
  try {
    const text = await req.text();
    if (text.length > 128 * 1024) throw new Error("リクエストが大きすぎます。");
    const asset = parseAsset(JSON.parse(text).asset, 0);
    const input = asset.kind === "video" ? await resolveAssetInputPath(asset) : null;
    const clock = input ? await inspectSourceAvClock(input) : null;
    return NextResponse.json({ videoOrigin: clock?.videoOrigin ?? null });
  } catch {
    return NextResponse.json({ videoOrigin: null }, { status: 400 });
  }
}
