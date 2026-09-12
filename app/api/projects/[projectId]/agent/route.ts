import { NextResponse } from 'next/server';
import { guardRequest, readJson, validateRelativePath } from '@/lib/security';
import { planProjectChange } from '@/lib/agent/planner';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  let supabase: any = null;
  let runId: string | null = null;

  try {
    const { projectId } = await params;

    const guard = await guardRequest(req, 'agent-run', 8);
    if (guard instanceof NextResponse) return guard;

    ({ supabase } = guard);

    const body = await readJson(req);
    const chatId = typeof body.chatId === 'string' ? body.chatId : '';
    const request = typeof body.request === 'string' ? body.request.trim() : '';

    if (!chatId) {
      return NextResponse.json({ error: 'Chat is required.' }, { status: 400 });
    }

    if (!request) {
      return NextResponse.json({ error: 'Request is required.' }, { status: 400 });
    }

    if (request.length > 12000) {
      return NextResponse.json({ error: 'Request is too long.' }, { status: 413 });
    }

    const { data: project } = await supabase
      .from('projects')
      .select('id,name')
      .eq('id', projectId)
      .single();

    if (!project) {
      return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    }

    const { data: chat } = await supabase
      .from('chats')
      .select('id')
      .eq('id', chatId)
      .eq('project_id', projectId)
      .single();

    if (!chat) {
      return NextResponse.json({ error: 'Chat not found.' }, { status: 404 });
    }

    const { data: existing, error: fileError } = await supabase
      .from('project_files')
      .select('path,content')
      .eq('project_id', projectId)
      .order('path');

    if (fileError) throw fileError;

    const { data: memories, error: memoryError } = await supabase
      .from('memories')
      .select('type,content')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(60);

    if (memoryError) throw memoryError;

    const { data: history, error: historyError } = await supabase
      .from('messages')
      .select('role,content')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(30);

    if (historyError) throw historyError;

    const conversation = (history ?? [])
      .reverse()
      .map((m: any) => `${m.role.toUpperCase()}: ${m.content}`);

    const files = (existing ?? []).map((f: any) => ({
      path: f.path,
      content: f.content,
    }));

    const projectMemory = (memories ?? []).map(
      (m: any) => `[${m.type}] ${m.content}`
    );

    const plan = await planProjectChange({
      request,
      files,
      projectMemory,
      conversation,
      iteration: 1,
    });

    const safeActions = plan.actions.filter((action: any) => {
      if (action.type === 'save_memory') {
        return typeof action.content === 'string' && action.content.length <= 5000;
      }

      try {
        validateRelativePath(action.path);

        if (action.type === 'delete_file') {
          return true;
        }

        return (
          typeof action.content === 'string' &&
          action.content.length <= 1_000_000
        );
      } catch {
        return false;
      }
    });

    const { error: userMessageError } = await supabase
      .from('messages')
      .insert({
        chat_id: chatId,
        role: 'user',
        content: request,
      });

    if (userMessageError) throw userMessageError;

    const { data: run, error: runError } = await supabase
      .from('agent_runs')
      .insert({
        project_id: projectId,
        chat_id: chatId,
        request,
        status: 'pending',
        summary: plan.summary,
        max_iterations: 3,
      })
      .select()
      .single();

    if (runError) throw runError;

    runId = run.id;

    for (const action of safeActions) {
      const previous =
        action.type === 'save_memory'
          ? null
          : files.find((f: any) => f.path === action.path)?.content ?? null;

      const { error: actionError } = await supabase
        .from('agent_actions')
        .insert({
          run_id: run.id,
          iteration: 1,
          action_type: action.type,
          path: "path" in action ? action.path : null,
          before_content: previous,
          memory_type:
            action.type === 'save_memory' ? action.memoryType : null,
          after_content:
            action.type === 'delete_file' || action.type === 'save_memory'
              ? action.type === 'save_memory'
                ? action.content
                : null
              : action.content,
        });

      if (actionError) throw actionError;
    }

    const summary =
      plan.summary ||
      'I prepared a proposed implementation. Review it before applying any changes.';

    const assistantContent =
      `I prepared a proposed implementation, but I have not changed your files.\n\n` +
      `${summary}\n\n` +
      `Review the proposed changes and approve them when you're ready.`;

    const { data: assistant, error: assistantError } = await supabase
      .from('messages')
      .insert({
        chat_id: chatId,
        role: 'assistant',
        content: assistantContent,
      })
      .select()
      .single();

    if (assistantError) throw assistantError;

    await supabase
      .from('chats')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', chatId);

    return NextResponse.json({
      runId: run.id,
      status: 'pending',
      summary,
      iterations: [
        {
          iteration: 1,
          summary: plan.summary,
          notes: plan.notes,
          actions: safeActions,
        },
      ],
      actions: safeActions,
      message: assistant,
    });
  } catch (e) {
    if (supabase && runId) {
      await supabase
        .from('agent_runs')
        .update({
          status: 'failed',
          summary: e instanceof Error ? e.message : 'Agent proposal failed.',
          completed_at: new Date().toISOString(),
        })
        .eq('id', runId);
    }

    const message =
      e instanceof Error ? e.message : 'Agent proposal failed.';

    const status = /Authentication|required/i.test(message) ? 401 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
