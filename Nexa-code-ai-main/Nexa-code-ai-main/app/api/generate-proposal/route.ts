import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { streamWithFailover, type AIMessage, type FailoverKey, type Provider } from '@/lib/ai/failover';
import { loadUserProviderKeys, selectProvider } from '@/lib/ai/user-keys';
import { checkUsageLimit, incrementUsage } from '@/lib/limits';
import { ensureNextProjectShell, ensureProjectPackage, type ProjectFile } from '@/lib/project-completeness';

export const runtime = 'nodejs';

const SYSTEM = `You are Nexa, senior full-stack dev. Based on conversation, output detailed plan, then output files EXACTLY like:
---FILE: app/page.tsx---
full file content here
---FILE: lib/utils.ts---
content
List ALL files needed for feature. Production-ready Next.js 14 Tailwind code. No explanation outside file blocks.`;

const FILE_PATTERN = /---FILE:\s*(.+?)---\s*([\s\S]*?)(?=---FILE:|$)/g;

function parseFiles(content: string) {
  const byPath = new Map<string, { path: string; content: string }>();
  FILE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATTERN.exec(content)) !== null) {
    const path = match[1].trim().replace(/^['"]|['"]$/g, '').replace(/^\/+/, '');
    const fileContent = match[2]
      .replace(/^\s*```[\w-]*\r?\n/, '')
      .replace(/\r?\n?```\s*$/, '')
      .replace(/^\n/, '')
      .replace(/\s+$/, '\n');
    if (!path || path.includes('..') || path.includes('\\')) continue;
    byPath.set(path, { path, content: fileContent });
  }
  return Array.from(byPath.values());
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
  const messages: AIMessage[] = [
    { role: 'system', content: SYSTEM + context },
    ...safeHistory,
  ];

  let generated = '';
  try {
    await streamWithFailover({
      provider,
      messages,
      keys: keysByProvider[provider],
      keysByProvider: failoverKeysByProvider,
      onChunk: async chunk => { generated += chunk; },
      outputTokens: 16384,
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (raw.startsWith('KEYS_EXHAUSTED::')) {
      const marker = 'KEYS_EXHAUSTED::';
      const payloadAndError = raw.slice(marker.length);
      const separator = payloadAndError.lastIndexOf('::');
      const triedJson = separator >= 0 ? payloadAndError.slice(0, separator) : payloadAndError;
      const lastErr = separator >= 0 ? payloadAndError.slice(separator + 2) : 'All providers failed';
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

  files = ensureProjectPackage(files) as ProjectFile[];
  const completeness = ensureNextProjectShell(files);
  if (completeness.errors.length) {
    console.error('[NEXA INCOMPLETE PROPOSAL]', completeness.errors);
    return NextResponse.json({ error: 'Nexa stopped before producing a complete project. Please regenerate the proposal.', details: completeness.errors, warnings: completeness.warnings }, { status: 422 });
  }
  if (completeness.warnings.length) console.warn('[NEXA PROJECT SHELL]', completeness.warnings);
  files = completeness.files;
  generated = files.map(file => `---FILE: ${file.path}---\n${file.content}`).join('\n');

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
