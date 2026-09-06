import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/auth";
import { guardRequest, validateRelativePath } from "@/lib/security";

export async function DELETE(_: Request, { params }: { params: Promise<{ projectId: string; path: string[] }> }) {
  try {
    const { projectId, path: parts } = await params;
    const guard = await guardRequest(_, 'file-delete', 60);
    if (guard instanceof Response) return guard;
    const { supabase, user } = guard;
    const path = validateRelativePath(parts.join('/'));
    const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).eq("owner_id", user.id).single();
    if (!project) throw new Error("Project not found.");
    const { error } = await supabase.from("project_files").delete().eq("project_id", projectId).eq("path", path);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not delete file." }, { status: 500 });
  }
}
