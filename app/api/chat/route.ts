import { NextResponse } from "next/server";
import { createGatewayForUser } from "@/lib/ai/gateway";
import { requireUser } from "@/lib/supabase/auth";

type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function POST(req: Request) {
  try {
    const { supabase, user } = await requireUser();
    const body = await req.json().catch(() => ({}));

    const message =
      typeof body.message === "string" ? body.message.trim() : "";
    const chatId =
      typeof body.chatId === "string" ? body.chatId.trim() : "";

    if (!message) {
      return NextResponse.json(
        { error: "Message is required." },
        { status: 400 }
      );
    }

    if (message.length > 12000) {
      return NextResponse.json(
        { error: "Message is too long." },
        { status: 413 }
      );
    }

    if (!chatId) {
      return NextResponse.json(
        { error: "Chat is required." },
        { status: 400 }
      );
    }

    const { data: chat, error: chatError } = await supabase
      .from("chats")
      .select("id, project_id, projects!inner(owner_id)")
      .eq("id", chatId)
      .eq("projects.owner_id", user.id)
      .single();

    if (chatError || !chat) {
      return NextResponse.json(
        { error: "Chat not found." },
        { status: 404 }
      );
    }

    const projectContextPattern = /\b(project|workspace|codebase|repository|repo|file|files|package\.json|vercel|deploy|deployment|build|error|bug|server|calculator)\b/i;

    let projectContext = "";
    if (projectContextPattern.test(message)) {
      const { data: project } = await supabase
        .from("projects")
        .select("id, name, description")
        .eq("id", chat.project_id)
        .single();

      const { data: files } = await supabase
        .from("project_files")
        .select("path, content")
        .eq("project_id", chat.project_id)
        .order("path");

      const { data: memories } = await supabase
        .from("memories")
        .select("type, content")
        .eq("project_id", chat.project_id)
        .order("created_at", { ascending: false })
        .limit(30);

      const fileContext = (files ?? [])
        .map((file: { path: string; content: string }) =>
          `FILE: ${file.path}\n${file.content}`
        )
        .join("\n\n")
        .slice(0, 180000);

      const memoryContext = (memories ?? [])
        .map((memory: { type: string; content: string }) =>
          `[${memory.type}] ${memory.content}`
        )
        .join("\n")
        .slice(0, 20000);

      projectContext = `
CURRENT PROJECT:
Name: ${project?.name ?? "Unknown"}
Description: ${project?.description ?? "None"}

PROJECT FILES:
${fileContext || "No project files found."}

PROJECT MEMORY:
${memoryContext || "No project memory found."}
`;
    }

    const history: HistoryMessage[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (item: unknown): item is HistoryMessage =>
              !!item &&
              typeof item === "object" &&
              "role" in item &&
              "content" in item &&
              ((item as HistoryMessage).role === "user" ||
                (item as HistoryMessage).role === "assistant") &&
              typeof (item as HistoryMessage).content === "string"
          )
          .slice(-30)
      : [];

    const conversation = history
      .map(
        (item) =>
          `${item.role === "user" ? "USER" : "NEXA"}: ${item.content}`
      )
      .join("\n");

    const gateway = await createGatewayForUser();

    const result = await gateway.complete({
      system: `You are Nexa Code AI, a friendly, capable AI assistant.

Your job is to have a natural conversation with the user.

You are NOT required to talk about coding, projects, files, deployment, or software unless the user asks about those things.

Handle greetings warmly and naturally. If the user says hello, greet them appropriately and invite them to continue. Answer general questions, explanations, brainstorming, writing help, everyday questions, and casual conversation normally.

When the user is discussing a coding idea without explicitly asking you to modify their project, you can discuss and advise rather than changing files.

Be concise but conversational. Match the user's tone.

Never pretend that you performed an action you did not perform.
Never claim code was executed, tested, deployed, or verified unless a real operation actually confirmed it.
Do not invent project changes or tool results.
When project context is provided, treat it as the source of truth. Do not guess about files, frameworks, dependencies, deployment configuration, or project architecture when the supplied project files can answer the question.
You may explain or discuss project changes, but this conversational endpoint must never modify project files.

Recent conversation:
${conversation || "No previous conversation."}

${projectContext}`,
      user: message,
    });

    const { error: userMessageError } = await supabase
      .from("messages")
      .insert({
        chat_id: chatId,
        role: "user",
        content: message,
      });

    if (userMessageError) {
      throw userMessageError;
    }

    const { data: assistantMessage, error: assistantMessageError } =
      await supabase
        .from("messages")
        .insert({
          chat_id: chatId,
          role: "assistant",
          content: result.text,
        })
        .select()
        .single();

    if (assistantMessageError) {
      throw assistantMessageError;
    }

    const now = new Date().toISOString();

    await supabase
      .from("chats")
      .update({ updated_at: now })
      .eq("id", chatId);

    await supabase
      .from("projects")
      .update({ updated_at: now })
      .eq("id", chat.project_id);

    return NextResponse.json({
      message: result.text,
      provider: result.provider,
      model: result.model,
      saved: true,
      chatMessage: assistantMessage,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Nexa could not respond right now.",
      },
      { status: 500 }
    );
  }
}
