import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/auth";

async function verify(projectId: string) {
  const { supabase, user } = await requireUser();
  const { data } = await supabase.from("projects").select("id").eq("id", projectId).eq("owner_id", user.id).single();
  if (!data) throw new Error("Project not found.");
  return supabase;
}

export async function GET(_: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const supabase = await verify(projectId);
    const { data, error } = await supabase.from("chats").select("*").eq("project_id", projectId).order("updated_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({ chats: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load chats." }, { status: 404 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const supabase = await verify(projectId);
    const body = await req.json();
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "New chat";
    const { data, error } = await supabase.from("chats").insert({ project_id: projectId, title }).select().single();
    if (error) throw error;
    return NextResponse.json({ chat: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create chat." }, { status: 500 });
  }
}
