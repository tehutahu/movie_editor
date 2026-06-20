import { NextResponse } from "next/server";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import { buildFileStreamResponse } from "@/lib/fileStream";
import { assertStorageId } from "@/lib/validation";

export const runtime = "nodejs";

type Params = { params: Promise<{ assetId: string }> };

export async function GET(req: Request, { params }: Params) {
  try {
    const { assetId } = await params;
    assertStorageId("assetId", assetId);
    const inputPath = await resolveAssetInputPath(assetId);
    if (!inputPath) {
      return NextResponse.json({ error: "素材が見つかりません。" }, { status: 404 });
    }
    return buildFileStreamResponse(inputPath, req);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
