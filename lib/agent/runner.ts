import type { SupabaseClient } from '@supabase/supabase-js';
import { planProjectChange } from './planner';
import { AgentAction, ProjectFile, VerificationResult } from './types';
import { validateProjectActions } from './validation';
import { verifyProjectBuild } from './verifier';

export type StoredAgentAction = {
  id?: string;
  iteration: number;
  action_type: string;
  path: string | null;
  before_content: string | null;
  after_content: string | null;
  memory_type: 'decision' | 'context' | 'preference' | null;
};

export type ApprovedAgentRun = {
  id: string;
  project_id: string;
  chat_id: string | null;
  request: string;
  summary: string | null;
  max_iterations: number;
};

type RunExecutionResult = {
  status: 'completed' | 'failed';
  summary: string;
  actions: StoredAgentAction[];
  verification: VerificationResult | null;
  repairAttempts: number;
};

function toAgentAction(action: StoredAgentAction): AgentAction | null {
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

async function loadFiles(supabase: SupabaseClient, projectId: string): Promise<ProjectFile[]> {
  const { data, error } = await supabase
    .from('project_files')
    .select('path,content')
    .eq('project_id', projectId)
    .order('path');
  if (error) throw error;
  return (data ?? []).map((file) => ({ path: file.path, content: file.content }));
}

async function updateRun(supabase: SupabaseClient, runId: string, values: Record<string, unknown>) {
  const { error } = await supabase.from('agent_runs').update(values).eq('id', runId);
  if (error) throw error;
}

async function applyActions(
  supabase: SupabaseClient,
  projectId: string,
  actions: StoredAgentAction[],
) {
  for (const action of actions) {
    if (action.action_type === 'save_memory') {
      const { error } = await supabase.from('memories').insert({
        project_id: projectId,
        type: action.memory_type ?? 'context',
        content: action.after_content ?? '',
      });
      if (error) throw error;
      continue;
    }

    if (!action.path) continue;
    if (action.action_type === 'delete_file') {
      const { error } = await supabase
        .from('project_files')
        .delete()
        .eq('project_id', projectId)
        .eq('path', action.path);
      if (error) throw error;
      continue;
    }

    const { data: current, error: currentError } = await supabase
      .from('project_files')
      .select('version')
      .eq('project_id', projectId)
      .eq('path', action.path)
      .maybeSingle();
    if (currentError) throw currentError;

    const { error } = await supabase.from('project_files').upsert(
      {
        project_id: projectId,
        path: action.path,
        content: action.after_content ?? '',
        version: (current?.version ?? 0) + 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,path' },
    );
    if (error) throw error;
  }
}

async function recordActions(
  supabase: SupabaseClient,
  runId: string,
  actions: StoredAgentAction[],
) {
  if (!actions.length) return;
  const { error } = await supabase.from('agent_actions').insert(
    actions.map((action) => ({
      run_id: runId,
      iteration: action.iteration,
      action_type: action.action_type,
      path: action.path,
      before_content: action.before_content,
      after_content: action.after_content,
      memory_type: action.memory_type,
    })),
  );
  if (error) throw error;
}

async function loadPlanningContext(supabase: SupabaseClient, run: ApprovedAgentRun) {
  const [{ data: memories, error: memoryError }, { data: messages, error: messageError }] = await Promise.all([
    supabase
      .from('memories')
      .select('type,content')
      .eq('project_id', run.project_id)
      .order('created_at', { ascending: false })
      .limit(60),
    run.chat_id
      ? supabase
          .from('messages')
          .select('role,content')
          .eq('chat_id', run.chat_id)
          .order('created_at', { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (memoryError) throw memoryError;
  if (messageError) throw messageError;
  return {
    projectMemory: (memories ?? []).map((memory) => `[${memory.type}] ${memory.content}`),
    conversation: (messages ?? [])
      .reverse()
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`),
  };
}

function formatVerificationFailure(result: VerificationResult) {
  const staticErrors = result.staticValidation.errors.map((error) => `- ${error.message}`).join('\n');
  const output = result.build.output ? `\n\nBuild output:\n${result.build.output}` : '';
  return [
    result.build.reason ?? 'Verification failed.',
    staticErrors ? `Static consistency errors:\n${staticErrors}` : '',
    output,
  ]
    .filter(Boolean)
    .join('\n');
}

function verificationRecord(result: VerificationResult) {
  return {
    phase: result.phase,
    ok: result.ok,
    static: result.staticValidation,
    build: result.build,
    recorded_at: new Date().toISOString(),
  };
}

async function failRun(
  supabase: SupabaseClient,
  run: ApprovedAgentRun,
  summary: string,
  verification: VerificationResult | null,
  repairAttempts: number,
  actions: StoredAgentAction[],
  verificationHistory: ReturnType<typeof verificationRecord>[] = [],
): Promise<RunExecutionResult> {
  await updateRun(supabase, run.id, {
    status: 'failed',
    summary,
    repair_attempts: repairAttempts,
    ...(verification
      ? { verification: { latest: verificationRecord(verification), history: verificationHistory } }
      : {}),
    completed_at: new Date().toISOString(),
  });
  return { status: 'failed', summary, actions, verification, repairAttempts };
}

export async function executeApprovedRun(
  supabase: SupabaseClient,
  run: ApprovedAgentRun,
  initialActions: StoredAgentAction[],
): Promise<RunExecutionResult> {
  await applyActions(supabase, run.project_id, initialActions);
  const allActions = [...initialActions];
  let repairAttempts = 0;
  const verificationHistory: ReturnType<typeof verificationRecord>[] = [];

  while (true) {
    const files = await loadFiles(supabase, run.project_id);
    await updateRun(supabase, run.id, {
      status: 'verifying',
      repair_attempts: repairAttempts,
      verification: { phase: 'running', repair_attempts: repairAttempts },
    });

    const verification = await verifyProjectBuild(files);
    const currentVerification = verificationRecord(verification);
    verificationHistory.push(currentVerification);
    await updateRun(supabase, run.id, {
      status: verification.ok ? 'completed' : 'verifying',
      repair_attempts: repairAttempts,
      verification: { latest: currentVerification, history: verificationHistory },
    });

    if (verification.ok) {
      const summary =
        repairAttempts > 0
          ? `Approved changes were applied and the production build passed after ${repairAttempts} repair attempt${repairAttempts === 1 ? '' : 's'}.`
          : 'Approved changes were applied and the production build passed.';
      await updateRun(supabase, run.id, {
        status: 'completed',
        summary,
        verification: { latest: currentVerification, history: verificationHistory },
        completed_at: new Date().toISOString(),
      });
      return { status: 'completed', summary, actions: allActions, verification, repairAttempts };
    }

    if (verification.phase === 'unsupported' || repairAttempts >= Math.max(0, run.max_iterations)) {
      const summary =
        verification.phase === 'unsupported'
          ? `Approved changes were applied, but the project could not be marked complete. ${formatVerificationFailure(verification)}`
          : `The production build still fails after ${repairAttempts} repair attempt${repairAttempts === 1 ? '' : 's'}. ${formatVerificationFailure(verification)}`;
      return failRun(supabase, run, summary, verification, repairAttempts, allActions, verificationHistory);
    }

    repairAttempts += 1;
    await updateRun(supabase, run.id, {
      status: 'repairing',
      repair_attempts: repairAttempts,
      summary: `Production verification failed. Generating repair ${repairAttempts} of ${run.max_iterations}.`,
      verification: { latest: currentVerification, history: verificationHistory },
    });

    const context = await loadPlanningContext(supabase, run);
    const repairPlan = await planProjectChange({
      request: `${run.request}\n\nREPAIR REQUIRED: The approved implementation was applied, but verification failed. Diagnose and repair the actual failure below. Do not declare success; return only the smallest coherent corrective actions.\n\n${formatVerificationFailure(verification)}`,
      files,
      projectMemory: context.projectMemory,
      conversation: context.conversation,
      iteration: repairAttempts + 1,
    });
    const repairValidation = validateProjectActions(files, repairPlan.actions);
    if (!repairValidation.ok) {
      const summary = `The repair plan was rejected by static consistency checks: ${repairValidation.errors.map((error) => error.message).join(' ')}`;
      return failRun(supabase, run, summary, verification, repairAttempts, allActions, verificationHistory);
    }

    const currentByPath = new Map(files.map((file) => [file.path, file.content]));
    const repairActions: StoredAgentAction[] = repairPlan.actions.map((action) => ({
      iteration: repairAttempts + 1,
      action_type: action.type,
      path: 'path' in action ? action.path : null,
      before_content: 'path' in action ? currentByPath.get(action.path) ?? null : null,
      after_content: action.type === 'delete_file' ? null : action.content,
      memory_type: action.type === 'save_memory' ? action.memoryType : null,
    }));
    await recordActions(supabase, run.id, repairActions);
    await applyActions(supabase, run.project_id, repairActions);
    allActions.push(...repairActions);
  }
}