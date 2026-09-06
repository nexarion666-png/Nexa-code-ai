import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/auth";

export async function GET(_: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase.from("projects").select("*").eq("id", projectId).eq("owner_id", user.id).single();
    if (error || !data) throw new Error("Project not found.");
    return NextResponse.json({ project: data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load project." }, { status: 404 });
  }
}
