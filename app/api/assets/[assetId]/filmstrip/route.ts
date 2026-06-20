import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getMediaStorage } from "@/lib/storage";
import { assertStorageId } from "@/lib/validation";

export const runtime = "nodejs";

type Params = { params: Promise<{ assetId: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { assetId } = await params;
    assertStorageId("assetId", assetId);
    const storage = getMediaStorage();
    const stripPath = await storage.getThumbnailStripPath(assetId);
    if (!stripPath) {
      return NextResponse.json({ error: "filmstrip がありません。" }, { status: 404 });
    }

    const st = await stat(stripPath);
    const nodeStream = createReadStream(stripPath);
    const web = Readable.toWeb(nodeStream);
    return new Response(web as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(st.size),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
