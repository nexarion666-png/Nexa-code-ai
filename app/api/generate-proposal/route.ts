import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { streamWithFailover, type AIMessage, type FailoverKey, type Provider } from '@/lib/ai/failover';
import { loadUserProviderKeys, selectProvider } from '@/lib/ai/user-keys';
import { checkUsageLimit, incrementUsage } from '@/lib/limits';
import { ensureCompleteNextProject, serializeFileBlocks } from '@/lib/project-completeness';

export const runtime = 'nodejs';
export const maxDuration = 300;

const SYSTEM = `You are Nexa, senior full-stack dev. Based on conversation, output detailed plan, then output files EXACTLY like:
---FILE: app/page.tsx---
full file content here
---FILE: lib/utils.ts---
content
List ALL files needed for feature. Production-ready Next.js 14 Tailwind code. No explanation outside file blocks.`;

const FILE_PATTERN = /---\s*FILE:\s*(.+?)\s*---\s*([\s\S]*?)(?=---\s*FILE:|$)/g;

const GENERATE_NOW = 'The requirements are settled. Do not ask questions and do not write any text outside file blocks. Output the complete set of files now, each starting with a line exactly like ---FILE: path/to/file.tsx--- followed by the full file content.';

function parseFiles(content: string) {
  const files: { path: string; content: string }[] = [];
  FILE_PATTERN.lastIndex = 0;
  const byPath = new Map<string, { path: string; content: string }>();
  let match: RegExpExecArray | null;
  while ((match = FILE_PATTERN.exec(content)) !== null) {
    const path = match[1].trim().replace(/^['"]|['"]$/g, '').replace(/^\/+/, '');
    const fileContent = match[2]
      .replace(/^\s*```[\w-]*\r?\n/, '')
      .replace(/\r?\n?```\s*$/, '')
      .replace(/^\n/, '')
      .replace(/\s+$/, '\n');
    if (!path || path.includes('..') || path.includes('\\')) continue;
    // Last complete occurrence wins. This prevents an earlier truncated duplicate
    // from replacing a later complete version of the same file.
    byPath.set(path, { path, content: fileContent });
  }
  byPath.forEach(file => files.push(file));
  return files;
}


async function repairGeneratedProject({
  provider,
  keysByProvider,
  originalMessages,
  currentFiles,
  validationError,
}: {
  provider: Provider;
  keysByProvider: Record<Provider, FailoverKey[]>;
  originalMessages: AIMessage[];
  currentFiles: { path: string; content: string }[];
  validationError: string;
}) {
  const existingPaths = currentFiles.map(file => file.path).join('\n');
  const repairPrompt: AIMessage = {
    role: 'user',
    content: `The generated Next.js project failed validation. Repair ONLY the missing or invalid project files required to make the project complete. Do NOT replace valid files and do NOT create placeholders.\n\nValidation error:\n${validationError}\n\nFiles already generated:\n${existingPaths || '(none)'}\n\nCRITICAL: If the project uses a src/ directory, use src/app/page.tsx and src/app/layout.tsx. If it uses a root app/ directory, use app/page.tsx and app/layout.tsx. Resolve imports according to tsconfig.json. Generate every missing file needed to satisfy the validation error. Output ONLY FILE blocks in this exact format:\n---FILE: path/to/file.tsx---\nfull file content`,
  };
  const repairMessages: AIMessage[] = [
    ...originalMessages,
    repairPrompt,
  ];
  let repaired = '';
  await streamWithFailover({
    provider,
    messages: repairMessages,
    keys: keysByProvider[provider] ?? [],
    keysByProvider,
    mode: 'generation',
    onChunk: async chunk => { repaired += chunk; },
  });
  return parseFiles(repaired);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const projectId = String(body.projectId ?? '');
  const history = Array.isArray(body.history) ? body.history : [];
  const requestedProvider = typeof body.provider === 'string' ? body.provider : undefined;
  if (!projectId) return NextResponse.json({ error: 'projectId is required.' }, { status: 400 });

  const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', user.id).single();
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const usageCheck = await checkUsageLimit(supabase, user, 'proposal');
  if (!usageCheck.allowed) return NextResponse.json({ error: `Daily proposal limit reached (${usageCheck.limit}). Upgrade to Pro for unlimited proposals.`, usage: usageCheck.usage }, { status: 429 });
  const keysByProvider = await loadUserProviderKeys(supabase, user.id);
  const provider = selectProvider(keysByProvider, requestedProvider);
  // loadUserProviderKeys returns decrypted string[] values. Normalize them once
  // at the route boundary so the failover engine receives its expected key shape.
  const failoverKeysByProvider: Record<Provider, FailoverKey[]> = {
    gemini: (keysByProvider.gemini ?? []).map((value, index) => ({ id: `gemini-key-${index + 1}`, value })),
    groq: (keysByProvider.groq ?? []).map((value, index) => ({ id: `groq-key-${index + 1}`, value })),
    openrouter: (keysByProvider.openrouter ?? []).map((value, index) => ({ id: `openrouter-key-${index + 1}`, value })),
  };
  if (!provider) return NextResponse.json({ error: 'No AI provider keys are configured. Open AI Settings and add a key.' }, { status: 400 });

  const safeHistory: AIMessage[] = history
    .slice(-50)
    .filter((m: unknown): m is { role: string; content: string } => {
      if (!m || typeof m !== 'object') return false;
      const candidate = m as { role?: unknown; content?: unknown };
      return (candidate.role === 'user' || candidate.role === 'assistant') && typeof candidate.content === 'string';
    })
    .map((m: { role: 'user' | 'assistant'; content: string }) => ({ role: m.role, content: m.content }));
  if (!safeHistory.length) return NextResponse.json({ error: 'A conversation is required before generating a proposal.' }, { status: 400 });

  const { data: existingFilesRaw, error: filesError } = await supabase
    .from('project_files')
    .select('path,content')
    .eq('project_id', projectId)
    .order('path');
  if (filesError) return NextResponse.json({ error: filesError.message }, { status: 500 });
  const existingFiles: { path: string; content: string | null }[] = existingFilesRaw ?? [];

  const context = existingFiles?.length
    ? `\n\nExisting project files are listed below. Preserve compatible existing behavior and update files where necessary:\n${existingFiles.map(file => `---EXISTING: ${file.path}---\n${file.content ?? ''}`).join('\n')}`
    : '';
  // The chat history ends on an assistant turn (or a conversation-mode message), so tell the
  // model explicitly to emit the file blocks now.
  const lastMessage = safeHistory[safeHistory.length - 1];
  const closingHistory: AIMessage[] = lastMessage.role === 'user'
    ? [...safeHistory.slice(0, -1), { role: 'user', content: `${lastMessage.content}\n\n${GENERATE_NOW}` }]
    : [...safeHistory, { role: 'user', content: GENERATE_NOW }];
  const messages: AIMessage[] = [
    { role: 'system', content: SYSTEM + context },
    ...closingHistory,
  ];

  let generated = '';
  try {
    await streamWithFailover({
      provider,
      messages,
      keys: failoverKeysByProvider[provider].map(key => key.value),
      keysByProvider: failoverKeysByProvider,
      mode: 'generation',
      onChunk: async chunk => { generated += chunk; },
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (raw.startsWith('KEYS_EXHAUSTED::')) {
      const payload = raw.slice('KEYS_EXHAUSTED::'.length);
      const separator = payload.lastIndexOf('::');
      const triedJson = separator >= 0 ? payload.slice(0, separator) : payload;
      const lastErr = separator >= 0 ? payload.slice(separator + 2) : 'All providers failed';
      let tried: unknown[] = [];
      try { tried = JSON.parse(triedJson); } catch { /* Keep UI-safe fallback. */ }
      console.error('[NEXA PROPOSAL KEYS_EXHAUSTED]', error);
      return NextResponse.json({ error: 'KEYS_EXHAUSTED', tried, message: lastErr, retryAfter: 60 }, { status: 429 });
    }
    console.error('[NEXA PROPOSAL ERROR]', error);
    return NextResponse.json({ error: 'Nexa could not generate the proposal.' }, { status: 502 });
  }

  let files = parseFiles(generated);
  if (!files.length) return NextResponse.json({ error: 'Nexa returned no file blocks. Ask Nexa to clarify the feature and try again.' }, { status: 422 });

  // Never save an incomplete proposal. Give the same provider/failover engine a targeted
  // repair pass so missing shell files (especially src/app/page.tsx) are generated instead
  // of creating fake placeholders or forcing the user to regenerate manually.
  let validationError = '';
  for (let repairAttempt = 0; repairAttempt < 2; repairAttempt++) {
    try {
      files = ensureCompleteNextProject(files);
      validationError = '';
      break;
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
      console.warn(`[NEXA PROPOSAL REPAIR] attempt=${repairAttempt + 1}: ${validationError}`);
      if (repairAttempt === 1) {
        console.error('[NEXA PROPOSAL VALIDATION ERROR]', validationError);
        return NextResponse.json({ error: validationError, code: 'PROPOSAL_VALIDATION_FAILED', repairAttempts: 2 }, { status: 422 });
      }
      try {
        const repairedFiles = await repairGeneratedProject({
          provider,
          keysByProvider: failoverKeysByProvider,
          originalMessages: messages,
          currentFiles: files,
          validationError,
        });
        if (!repairedFiles.length) throw new Error('Repair provider returned no file blocks.');
        const byPath = new Map(files.map(file => [file.path, file]));
        repairedFiles.forEach(file => byPath.set(file.path, file));
        const merged: { path: string; content: string }[] = [];
        byPath.forEach(file => merged.push(file));
        files = merged;
      } catch (repairError) {
        const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
        console.error('[NEXA PROPOSAL REPAIR FAILED]', repairMessage);
        return NextResponse.json({ error: validationError, code: 'PROPOSAL_VALIDATION_FAILED', repairAttempts: repairAttempt + 1 }, { status: 422 });
      }
    }
  }

  generated = serializeFileBlocks(files);

  const existingByPath = new Map((existingFiles ?? []).map(file => [file.path, file.content ?? '']));
  const { data: proposal, error: proposalError } = await supabase
    .from('proposals')
    .insert({ project_id: projectId, user_id: user.id, content: generated, status: 'pending' })
    .select('id')
    .single();
  if (proposalError || !proposal) return NextResponse.json({ error: proposalError?.message ?? 'Could not create proposal.' }, { status: 500 });

  const changes = files
    .filter(file => !existingByPath.has(file.path) || existingByPath.get(file.path) !== file.content)
    .map(file => ({
      proposal_id: proposal.id,
      path: file.path,
      operation: existingByPath.has(file.path) ? 'update' : 'create',
      old_content: existingByPath.get(file.path) ?? null,
      new_content: file.content,
    }));

  if (changes.length) {
    const { error: changesError } = await supabase.from('file_changes').insert(changes);
    if (changesError) {
      await supabase.from('proposals').delete().eq('id', proposal.id);
      return NextResponse.json({ error: changesError.message }, { status: 500 });
    }
  }

  try {
    await incrementUsage(supabase, user.id, 'proposal');
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not update usage.' }, { status: 500 });
  }

  const summary = `Proposal ready: ${changes.length} files to modify. [Review Changes]`;
  const { error: messageError } = await supabase.from('messages').insert({ project_id: projectId, user_id: user.id, role: 'assistant', content: summary });
  if (messageError) return NextResponse.json({ proposalId: proposal.id, changesCount: changes.length, warning: 'Proposal created, but the chat summary could not be saved.' });

  return NextResponse.json({ proposalId: proposal.id, changesCount: changes.length, provider });
}
