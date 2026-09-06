import { NextResponse } from 'next/server';
import { guardRequest, readJson, validateRelativePath } from '@/lib/security';
import { planProjectChange } from '@/lib/agent/planner';
import { applyActions } from '@/lib/agent/apply';

const MAX_ITERATIONS = 3;

export async function POST(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
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
    if (!chatId) return NextResponse.json({ error: 'Chat is required.' }, { status: 400 });
    if (!request) return NextResponse.json({ error: 'Request is required.' }, { status: 400 });
    if (request.length > 12000) return NextResponse.json({ error: 'Request is too long.' }, { status: 413 });

    const { data: project } = await supabase.from('projects').select('id,name').eq('id', projectId).single();
    if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    const { data: chat } = await supabase.from('chats').select('id').eq('id', chatId).eq('project_id', projectId).single();
    if (!chat) return NextResponse.json({ error: 'Chat not found.' }, { status: 404 });

    const { error: userMessageError } = await supabase.from('messages').insert({ chat_id: chatId, role: 'user', content: request });
    if (userMessageError) throw userMessageError;
    const { data: existing, error: fileError } = await supabase.from('project_files').select('path,content').eq('project_id', projectId).order('path');
    if (fileError) throw fileError;
    const { data: memories, error: memoryError } = await supabase.from('memories').select('type,content').eq('project_id', projectId).order('created_at', { ascending: false }).limit(60);
    if (memoryError) throw memoryError;
    const { data: history, error: historyError } = await supabase.from('messages').select('role,content').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(30);
    if (historyError) throw historyError;
    const conversation = (history ?? []).reverse().map((m: any) => `${m.role.toUpperCase()}: ${m.content}`);
    const { data: run, error: runError } = await supabase.from('agent_runs').insert({ project_id: projectId, request, status: 'running', max_iterations: MAX_ITERATIONS }).select().single();
    if (runError) throw runError;
    runId = run.id;

    const files = new Map<string, string>((existing ?? []).map((f: any) => [f.path, f.content]));
    const memoryTexts = (memories ?? []).map((m: any) => `[${m.type}] ${m.content}`);
    const iterations: any[] = [];
    const allActions: any[] = [];

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const plan = await planProjectChange({
        request,
        files: Array.from(files.entries()).map(([path, content]) => ({ path, content })),
        projectMemory: memoryTexts,
        conversation,
        iteration,
      });
      const safeActions = plan.actions.filter((action: any) => {
        if (action.type === 'save_memory') return action.content.length <= 5000;
        try { validateRelativePath(action.path); return action.content?.length <= 1_000_000 || action.type === 'delete_file'; }
        catch { return false; }
      });
      const before = new Map(files);
      const result = applyActions(files, safeActions);

      for (const action of safeActions) {
        if (action.type === 'save_memory') {
          const { error } = await supabase.from('memories').insert({ project_id: projectId, type: action.memoryType, content: action.content });
          if (error) throw error;
          memoryTexts.push(`[${action.memoryType}] ${action.content}`);
        } else {
          const previous = before.get(action.path) ?? null;
          const { error } = await supabase.from('agent_actions').insert({
            run_id: run.id,
            iteration,
            action_type: action.type,
            path: action.path,
            before_content: previous,
            after_content: action.type === 'delete_file' ? null : action.content,
          });
          if (error) throw error;
          if (action.type === 'delete_file') {
            const { error: deleteError } = await supabase.from('project_files').delete().eq('project_id', projectId).eq('path', action.path);
            if (deleteError) throw deleteError;
          } else {
            const current = await supabase.from('project_files').select('version').eq('project_id', projectId).eq('path', action.path).maybeSingle();
            if (current.error) throw current.error;
            const { error: saveError } = await supabase.from('project_files').upsert({
              project_id: projectId,
              path: action.path,
              content: action.content,
              version: (current.data?.version ?? 0) + 1,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'project_id,path' });
            if (saveError) throw saveError;
          }
        }
      }

      iterations.push({ iteration, summary: plan.summary, notes: plan.notes, actions: safeActions });
      allActions.push(...safeActions);
      if (!safeActions.some((a: any) => ['create_file', 'update_file', 'delete_file'].includes(a.type))) break;
      memoryTexts.push(`[iteration ${iteration}] ${plan.summary}`);
      if (result.changed.length === 0) break;
    }

    const summary = iterations.map(i => i.summary).join(' ') || 'No file changes were necessary.';
    const { data: assistant, error: assistantError } = await supabase.from('messages').insert({ chat_id: chatId, role: 'assistant', content: summary }).select().single();
    if (assistantError) throw assistantError;
    await supabase.from('chats').update({ updated_at: new Date().toISOString() }).eq('id', chatId);
    await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId);
    await supabase.from('agent_runs').update({ status: 'completed', summary, completed_at: new Date().toISOString() }).eq('id', run.id);
    return NextResponse.json({ runId: run.id, summary, iterations, actions: allActions, message: assistant });
  } catch (e) {
    if (supabase && runId) await supabase.from('agent_runs').update({ status: 'failed', summary: e instanceof Error ? e.message : 'Agent run failed.', completed_at: new Date().toISOString() }).eq('id', runId);
    const message = e instanceof Error ? e.message : 'Agent run failed.';
    const status = /Authentication|required/i.test(message) ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
