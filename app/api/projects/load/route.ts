import { NextResponse } from "next/server";
import { loadProject } from "@/lib/projectStorage";
import { projectError, readProjectRequest } from "@/lib/projectHttp";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const body = await readProjectRequest(req);
    return NextResponse.json(await loadProject(body.document, String(body.sessionId), body.replacements));
  } catch (e) { return projectError(e); }
}
