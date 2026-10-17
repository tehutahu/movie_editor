import { NextResponse } from "next/server";
import { resolveInputPath } from "@/lib/mediaSource";
import { probeRestoreInputAudio } from "@/lib/restoreInputAudio";

export const runtime = "nodejs";

/** Observation only: resolve exactly the input used by the existing restore POST. */
export async function GET(req: Request) {
  try {
    const query = new URL(req.url).searchParams;
    const resolved = await resolveInputPath({ videoId: query.get("videoId") ?? "", sourceJobId: query.get("sourceJobId") ?? undefined });
    const inputAudio = await probeRestoreInputAudio(resolved.inputPath);
    return NextResponse.json({ videoId: resolved.videoId, ...(resolved.sourceJobId ? { sourceJobId: resolved.sourceJobId } : {}), inputAudio }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: message.includes("見つかりません") ? 404 : 400, headers: { "Cache-Control": "no-store" } });
  }
}
