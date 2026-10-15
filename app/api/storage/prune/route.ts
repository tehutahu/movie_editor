import { NextResponse } from "next/server";
import { StorageRetentionError, pruneAllStorage } from "@/lib/storageRetention";
import { ensureStorageTrees } from "@/lib/storage";

export const runtime = "nodejs";

type Body = {
  keepIds?: unknown;
};

/** Collect only resources whose owners explicitly ended editing. Unknown ownership stays protected. */
export async function POST(req: Request) {
  try {
    await ensureStorageTrees();

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ error: "JSON body が不正です。" }, { status: 400 });
    }

    const raw = body.keepIds;
    const keepIds = Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];

    const result = await pruneAllStorage(keepIds);
    return NextResponse.json({
      ok: true,
      uploadsRemoved: result.uploadsRemoved,
      jobsRemoved: result.jobsRemoved,
      warning: result.warning,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: e instanceof StorageRetentionError ? e.status : 500 },
    );
  }
}
