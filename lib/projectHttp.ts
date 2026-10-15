import { MAX_PROJECT_JSON_BYTES } from "@/lib/editor/projectDocument";
import { MissingProjectMediaError } from "@/lib/projectStorage";
import { StorageRetentionError } from "@/lib/storageRetention";
import { NextResponse } from "next/server";
export async function readProjectRequest(
  req: Request,
): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("JSON が必要です。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PROJECT_JSON_BYTES)
        throw new StorageRetentionError(
          "JSON サイズが上限を超えています。",
          413,
        );
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("JSON 形式が不正です。");
  return raw as Record<string, unknown>;
}
export function projectError(e: unknown) {
  return NextResponse.json(
    {
      error: e instanceof Error ? e.message : String(e),
      ...(e instanceof MissingProjectMediaError ? { missing: e.missing } : {}),
    },
    {
      status:
        e instanceof StorageRetentionError
          ? e.status
          : e instanceof MissingProjectMediaError
            ? 409
            : 400,
    },
  );
}
