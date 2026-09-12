import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/auth';
import { validateRelativePath } from '@/lib/security';

export async function POST(
  _: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const { supabase, user } = await requireUser();

    const { data: run, error: runError } = await supabase
      .from('agent_runs')
      .select('*,projects!inner(owner_id)')
      .eq('id', runId)
      .eq('projects.owner_id', user.id)
      .single();

    if (runError || !run) {
      return NextResponse.json(
        { error: 'Agent proposal not found.' },
        { status: 404 }
      );
    }

    if (run.status !== 'pending') {
      return NextResponse.json(
        { error: `This proposal is already ${run.status}.` },
        { status: 409 }
      );
    }

    const { data: actions, error: actionsError } = await supabase
      .from('agent_actions')
      .select('*')
      .eq('run_id', runId)
      .order('iteration')
      .order('created_at');

    if (actionsError) throw actionsError;

    const safeActions = (actions ?? []).filter((action: any) => {
      if (action.action_type === 'save_memory') {
        return (
          typeof action.after_content === 'string' &&
          action.after_content.length <= 5000
        );
      }

      if (!action.path) return false;

      try {
        validateRelativePath(action.path);

        if (action.action_type === 'delete_file') {
          return true;
        }

        return (
          typeof action.after_content === 'string' &&
          action.after_content.length <= 1_000_000
        );
      } catch {
        return false;
      }
    });

    for (const action of safeActions) {
      if (action.action_type === 'save_memory') continue;

      const { data: current, error: currentError } = await supabase
        .from('project_files')
        .select('content')
        .eq('project_id', run.project_id)
        .eq('path', action.path)
        .maybeSingle();

      if (currentError) throw currentError;

      const currentContent = current?.content ?? null;

      if (currentContent !== action.before_content) {
        return NextResponse.json(
          {
            error: `Proposal is stale. The file "${action.path}" changed after this proposal was created. No changes were applied.`,
          },
          { status: 409 }
        );
      }
    }

    const { error: approvalError } = await supabase
      .from('agent_runs')
      .update({
        status: 'running',
        approved_at: new Date().toISOString(),
      })
      .eq('id', runId)
      .eq('status', 'pending');

    if (approvalError) throw approvalError;

    for (const action of safeActions) {
      if (action.action_type === 'save_memory') {
        const { error } = await supabase
          .from('memories')
          .insert({
            project_id: run.project_id,
            type: action.memory_type ?? 'context',
            content: action.after_content,
          });

        if (error) throw error;
        continue;
      }

      if (action.action_type === 'delete_file') {
        const { error } = await supabase
          .from('project_files')
          .delete()
          .eq('project_id', run.project_id)
          .eq('path', action.path);

        if (error) throw error;
        continue;
      }

      const { data: current, error: currentError } = await supabase
        .from('project_files')
        .select('version')
        .eq('project_id', run.project_id)
        .eq('path', action.path)
        .maybeSingle();

      if (currentError) throw currentError;

      const { error: saveError } = await supabase
        .from('project_files')
        .upsert(
          {
            project_id: run.project_id,
            path: action.path,
            content: action.after_content,
            version: (current?.version ?? 0) + 1,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'project_id,path' }
        );

      if (saveError) throw saveError;
    }

    const summary = run.summary || 'Approved changes were applied.';

    await supabase
      .from('agent_runs')
      .update({
        status: 'completed',
        summary,
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);

    if (run.chat_id) {
      await supabase.from('messages').insert({
        chat_id: run.chat_id,
        role: 'assistant',
        content: `Approved and applied the proposed changes.\n\n${summary}`,
      });

      await supabase
        .from('chats')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', run.chat_id);
    }

    return NextResponse.json({
      runId,
      status: 'completed',
      summary,
      actions: safeActions,
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : 'Could not approve agent proposal.';

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
