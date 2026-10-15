import { NextResponse } from "next/server";
import { protectStorageSession, releaseStorageSession, StorageRetentionError } from "@/lib/storageRetention";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const body = await req.json() as { sessionId?: unknown; action?: unknown; keepIds?: unknown };
    if (typeof body.sessionId !== "string") throw new Error("sessionId が必要です。");
    if (body.action === "release") return NextResponse.json({ ok: true, ...(await releaseStorageSession(body.sessionId)) });
    if (body.action !== "protect" || !Array.isArray(body.keepIds) || !body.keepIds.every(id => typeof id === "string")) throw new Error("保護ID一覧が不正です。");
    await protectStorageSession(body.sessionId, body.keepIds);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof StorageRetentionError ? e.status : 400 });
  }
}
