import { NextResponse } from "next/server";
import { displayNameFromOriginalFilename } from "@/lib/exportName";
import {
  ensureStorageTrees,
  newVideoId,
  pruneUploadsAfterSave,
  saveUploadDisplayName,
  saveUploadedVideo,
} from "@/lib/storage";
import {
  MAX_UPLOAD_BYTES,
  parseAllowedVideoExtension,
} from "@/lib/validation";

export const runtime = "nodejs";

/** 単一ファイルを `storage/uploads/<videoId>/input.<ext>` に保存します。 */
export async function POST(req: Request) {
  try {
    await ensureStorageTrees();

    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file が必要です（FormDataキー: file）。" }, { status: 400 });
    }

    const ext = parseAllowedVideoExtension(file.name);
    if (!ext) {
      return NextResponse.json(
        {
          error:
            "未対応の拡張子です（mp4/mkv/avi/mov/flv/wmvのみ）。",
        },
        { status: 400 },
      );
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: `ファイルサイズが上限（${MAX_UPLOAD_BYTES} バイト）を超えています。`,
        },
        { status: 413 },
      );
    }

    const buf = new Uint8Array(await file.arrayBuffer());
    const videoId = newVideoId();
    await saveUploadedVideo({ videoId, ext, bytes: buf });
    const displayName = displayNameFromOriginalFilename(file.name);
    await saveUploadDisplayName(videoId, displayName);
    await pruneUploadsAfterSave(videoId);

    return NextResponse.json({ videoId, originalName: file.name, displayName, ext });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
