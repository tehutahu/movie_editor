import { NextResponse } from "next/server";
import { readProject, deleteProject } from "@/lib/projectStorage";
import { projectError } from "@/lib/projectHttp";
export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };
export async function GET(_req: Request, ctx: Context) {
  try { return NextResponse.json(await readProject((await ctx.params).projectId), { headers: { "Content-Disposition": 'attachment; filename="project.json"', "Cache-Control": "no-store" } }); } catch (e) { return projectError(e); }
}
export async function DELETE(_req: Request, ctx: Context) {
  try { await deleteProject((await ctx.params).projectId); return NextResponse.json({ deleted: true }); } catch (e) { return projectError(e); }
}
