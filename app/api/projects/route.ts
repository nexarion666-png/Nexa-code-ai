import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/auth";
import { readJson } from "@/lib/security";

export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase.from("projects").select("*").eq("owner_id", user.id).order("updated_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({ projects: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load projects." }, { status: 401 });
  }
}

export async function POST(req: Request) {
  try {
    const { supabase, user } = await requireUser();
    const body = await readJson(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "Project name is required." }, { status: 400 });
    if (name.length > 120) return NextResponse.json({ error: "Project name is too long." }, { status: 400 });

    const { data, error } = await supabase.from("projects").insert({
      owner_id: user.id,
      name,
      description: typeof body.description === "string" ? body.description.trim() : null
    }).select().single();
    if (error) throw error;

    const starterFiles = [
      { path: "README.md", content: `# ${name}\n\nBuilt with Nexa Code AI.\n` },
      { path: ".gitignore", content: "node_modules\n.next\n.env.local\n" }
    ];
    await supabase.from("project_files").insert(starterFiles.map((file) => ({ project_id: data.id, ...file, version: 1 })));
    await supabase.from("chats").insert({ project_id: data.id, title: "Project kickoff" });

    return NextResponse.json({ project: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create project." }, { status: 500 });
  }
}
