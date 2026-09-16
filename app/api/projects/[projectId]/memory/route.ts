import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/auth";

export async function GET(_: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const { supabase, user } = await requireUser();
    const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).eq("owner_id", user.id).single();
    if (!project) throw new Error("Project not found.");
    const { data, error } = await supabase.from("memories").select("*").eq("project_id", projectId).order("created_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({ memories: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load memory." }, { status: 404 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const { supabase, user } = await requireUser();
    const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).eq("owner_id", user.id).single();
    if (!project) throw new Error("Project not found.");

    const body = await req.json();
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const type = typeof body.type === "string" ? body.type : "context";
    if (!content) return NextResponse.json({ error: "Memory content is required." }, { status: 400 });

    const { data, error } = await supabase.from("memories").insert({ project_id: projectId, type, content }).select().single();
    if (error) throw error;
    return NextResponse.json({ memory: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save memory." }, { status: 500 });
  }
}
