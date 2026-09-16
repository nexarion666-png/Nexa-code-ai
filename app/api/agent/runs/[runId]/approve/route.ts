import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/auth';
import { validateRelativePath } from '@/lib/security';
import { AgentAction } from '@/lib/agent/types';
import { executeApprovedRun, StoredAgentAction } from '@/lib/agent/runner';
import { validateProjectActions } from '@/lib/agent/validation';

export const runtime = 'nodejs';

function storedActionToAgentAction(action: StoredAgentAction): AgentAction | null {
  if (action.action_type === 'save_memory' && action.after_content && action.memory_type) {
    return { type: 'save_memory', memoryType: action.memory_type, content: action.after_content };
  }
  if (
    (action.action_type === 'create_file' || action.action_type === 'update_file') &&
    action.path &&
    typeof action.after_content === 'string'
  ) {
    return { type: action.action_type, path: action.path, content: action.after_content };
  }
  if (action.action_type === 'delete_file' && action.path) {
    return { type: 'delete_file', path: action.path };
  }
  return null;
}

export async function POST(
  _: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  let activeRunId: string | null = null;
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

    const unsafeAction = (actions ?? []).find((action: any) => {
      if (action.action_type === 'save_memory') {
        return typeof action.after_content !== 'string' || action.after_content.length > 5000;
      }

      if (!action.path) return true;

      try {
        validateRelativePath(action.path);

        if (action.action_type === 'delete_file') {
          return false;
        }

        return typeof action.after_content !== 'string' || action.after_content.length > 1_000_000;
      } catch {
        return true;
      }
    });
    if (unsafeAction) {
      return NextResponse.json(
        { error: 'This proposal contains an unsafe or oversized action and cannot be applied.' },
        { status: 422 },
      );
    }

    const safeActions = (actions ?? []) as StoredAgentAction[];
    const { data: currentFiles, error: filesError } = await supabase
      .from('project_files')
      .select('path,content')
      .eq('project_id', run.project_id)
      .order('path');
    if (filesError) throw filesError;

    const proposedActions = safeActions
      .map(storedActionToAgentAction)
      .filter((action: AgentAction | null): action is AgentAction => action !== null);
    if (proposedActions.length !== safeActions.length) {
      return NextResponse.json(
        { error: 'This proposal contains an unknown action type and cannot be applied.' },
        { status: 422 },
      );
    }
    const validation = validateProjectActions(currentFiles ?? [], proposedActions);
    if (!validation.ok) {
      return NextResponse.json(
        {
          error: 'This proposal no longer passes project consistency checks and was not applied.',
          validation,
        },
        { status: 422 },
      );
    }

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

    activeRunId = runId;
    const result = await executeApprovedRun(supabase, {
      id: run.id,
      project_id: run.project_id,
      chat_id: run.chat_id,
      request: run.request,
      summary: run.summary,
      max_iterations: run.max_iterations ?? 3,
    }, safeActions);

    if (run.chat_id) {
      await supabase.from('messages').insert({
        chat_id: run.chat_id,
        role: 'assistant',
        content: result.summary,
      });

      await supabase
        .from('chats')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', run.chat_id);
    }

    return NextResponse.json({
      runId,
      status: result.status,
      summary: result.summary,
      actions: result.actions,
      verification: result.verification,
      repairAttempts: result.repairAttempts,
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : 'Could not approve agent proposal.';
    if (activeRunId) {
      await (async () => {
        const { supabase } = await requireUser();
        await supabase
          .from('agent_runs')
          .update({
            status: 'failed',
            summary: `Approval or verification failed: ${message}`,
            completed_at: new Date().toISOString(),
          })
          .eq('id', activeRunId);
      })();
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
