import { NextResponse } from "next/server";
import { requireUser } from "@/lib/supabase/auth";
import { planProjectChange } from "@/lib/agent/planner";

export async function GET(_: Request, { params }: { params: Promise<{ chatId: string }> }) {
  try {
    const { chatId } = await params;
    const { supabase, user } = await requireUser();
    const { data: chat } = await supabase.from("chats").select("id, project_id, projects!inner(owner_id)").eq("id", chatId).eq("projects.owner_id", user.id).single();
    if (!chat) throw new Error("Chat not found.");
    const { data, error } = await supabase.from("messages").select("*").eq("chat_id", chatId).order("created_at");
    if (error) throw error;
    return NextResponse.json({ messages: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load messages." }, { status: 404 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  try {
    const { chatId } = await params;
    const { supabase, user } = await requireUser();
    const { data: chat } = await supabase.from("chats").select("id, project_id, projects!inner(owner_id)").eq("id", chatId).eq("projects.owner_id", user.id).single();
    if (!chat) throw new Error("Chat not found.");

    const body = await req.json();
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) return NextResponse.json({ error: "Message is required." }, { status: 400 });

    await supabase.from("messages").insert({ chat_id: chatId, role: "user", content });

    const { data: files } = await supabase.from("project_files").select("path, content").eq("project_id", chat.project_id);
    const { data: memory } = await supabase.from("memories").select("content").eq("project_id", chat.project_id).order("created_at", { ascending: false }).limit(30);

    const plan = await planProjectChange({
      request: content,
      files: files ?? [],
      projectMemory: (memory ?? []).map((m: { content: string }) => m.content)
    });

    for (const action of plan.actions) {
      if (action.type === "create_file" || action.type === "update_file") {
        await supabase.from("project_files").upsert({
          project_id: chat.project_id,
          path: action.path,
          content: action.content,
          version: 1,
          updated_at: new Date().toISOString()
        }, { onConflict: "project_id,path" });
      } else if (action.type === "delete_file") {
        await supabase.from("project_files").delete().eq("project_id", chat.project_id).eq("path", action.path);
      } else if (action.type === "save_memory") {
        await supabase.from("memories").insert({
          project_id: chat.project_id,
          type: action.memoryType,
          content: action.content
        });
      }
    }

    const assistantContent = `${plan.summary}\n\n${plan.notes.length ? plan.notes.map((n) => `- ${n}`).join("\n") : "Project changes have been applied to the workspace."}`;
    const { data: assistant, error } = await supabase.from("messages").insert({
      chat_id: chatId,
      role: "assistant",
      content: assistantContent
    }).select().single();

    if (error) throw error;
    await supabase.from("chats").update({ updated_at: new Date().toISOString() }).eq("id", chatId);

    return NextResponse.json({ message: assistant, plan });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Agent request failed." }, { status: 500 });
  }
}
