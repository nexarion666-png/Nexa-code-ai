import { NextResponse } from "next/server";
import JSZip from "jszip";
import { requireUser } from "@/lib/supabase/auth";
import { validateRelativePath } from "@/lib/security";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const { supabase, user } = await requireUser();

    const { data: project } = await supabase
      .from("projects")
      .select("id,name")
      .eq("id", projectId)
      .eq("owner_id", user.id)
      .single();

    if (!project) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    const { data: files, error } = await supabase
      .from("project_files")
      .select("path,content")
      .eq("project_id", projectId)
      .order("path");

    if (error) throw error;

    const zip = new JSZip();
    for (const file of files ?? []) {
      zip.file(validateRelativePath(file.path), file.content ?? "");
    }

    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const safeName = String(project.name || "nexa-project")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "nexa-project";

    return new NextResponse(bytes as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeName}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not download project." },
      { status: 400 }
    );
  }
}
