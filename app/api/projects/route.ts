import { NextResponse } from "next/server";
import { listProjects, saveProject } from "@/lib/projectStorage";
import { projectError, readProjectRequest } from "@/lib/projectHttp";
export const runtime = "nodejs";
export async function GET() {
  try { return NextResponse.json({ projects: await listProjects() }); } catch (e) { return projectError(e); }
}
export async function POST(req: Request) {
  try {
    const body = await readProjectRequest(req);
    const revision = await saveProject(String(body.id), body.document);
    return NextResponse.json({ id: revision.id, createdAt: revision.createdAt, document: revision.document });
  } catch (e) { return projectError(e); }
}
