import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptApiKey } from '@/lib/ai/crypto';
import { loadUserProviderKeys, selectProvider } from '@/lib/ai/user-keys';
import { streamWithFailover, type AIMessage, type FailoverKey, type Provider } from '@/lib/ai/failover';
import { checkUsageLimit, incrementUsage } from '@/lib/limits';
import { validateProjectPreflight } from '@/lib/build-validation';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
const FILE_BLOCK = /---\s*FILE:\s*(.+?)\s*---\s*([\s\S]*?)(?=---\s*FILE:|$)/g;

type BuildEvent = { payload?: { text?: string; info?: { path?: string; step?: string; name?: string } } };
type ProjectFile = { path: string; content: string };

function parseFileBlocks(text: string): ProjectFile[] {
  const byPath = new Map<string, ProjectFile>();
  FILE_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_BLOCK.exec(text)) !== null) {
    const filePath = match[1].trim().replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
    if (!filePath || filePath.startsWith('/') || filePath.includes('\\') || filePath.split('/').includes('..')) continue;
    const content = match[2].replace(/^\s*```[\w-]*\r?\n/, '').replace(/\r?\n?```\s*$/, '').replace(/\s+$/, '\n');
    byPath.set(filePath, { path: filePath, content });
  }
  return Array.from(byPath.values());
}

function buildLogText(events: BuildEvent[]) {
  return events.map(event => {
    const payload = event.payload;
    return [payload?.info?.step, payload?.info?.name, payload?.info?.path, payload?.text].filter(Boolean).join(' | ');
  }).filter(Boolean).join('\n').slice(-24000);
}

function relevantContext(files: ProjectFile[], logs: string) {
  const paths = [...logs.matchAll(/(?:\.\/)?((?:src\/)?(?:app|pages|components|lib|types)\/[\w.$\[\]@/-]+\.(?:tsx?|jsx?|css|json))/g)].map(match => match[1]);
  const typeNames = [...logs.matchAll(/(?:type|interface)\s+([A-Z][A-Za-z0-9_]*)|type\s+([A-Z][A-Za-z0-9_]*)/g)].map(match => match[1] || match[2]).filter(Boolean);
  const priority = (file: ProjectFile) => {
    if (paths.includes(file.path)) return 0;
    if (['package.json', 'package-lock.json', 'tsconfig.json', 'next.config.js', 'next.config.mjs'].includes(file.path)) return 1;
    if (typeNames.some(name => new RegExp(`(?:type|interface|class|enum)\\s+${name}\\b`).test(file.content))) return 2;
    if (/\.(?:tsx?|jsx?)$/i.test(file.path)) return 3;
    return 4;
  };
  const ordered = [...files].sort((a, b) => priority(a) - priority(b));
  const selected: ProjectFile[] = [];
  let total = 0;
  for (const file of ordered) {
    if (selected.length >= 18 || total + file.content.length > 48000) continue;
    selected.push(file);
    total += file.content.length;
  }
  return selected.map(file => `---CURRENT: ${file.path}---\n${file.content}`).join('\n\n');
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const projectId = String(body.projectId ?? '').trim();
  if (!projectId) return NextResponse.json({ error: 'projectId is required.' }, { status: 400 });

  const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', user.id).maybeSingle();
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  // Reuse an existing pending proposal rather than creating duplicate repairs.
  const { data: pending } = await supabase.from('proposals').select('id,status').eq('project_id', projectId).eq('user_id', user.id).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (pending) return NextResponse.json({ proposalId: pending.id, reusedExistingProposal: true, message: 'A pending proposal already exists. Review it before preparing another repair.' });

  const { data: deployment } = await supabase.from('deployments').select('vercel_deployment_id,status').eq('project_id', projectId).eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!deployment?.vercel_deployment_id) return NextResponse.json({ error: 'No verifiable Vercel deployment was found.' }, { status: 404 });
  if (String(deployment.status).toUpperCase() !== 'ERROR') return NextResponse.json({ error: 'AI repair is available only after a confirmed failed Vercel build.' }, { status: 409 });

  const { data: credentials } = await supabase.from('user_github_tokens').select('vercel_token').eq('user_id', user.id).maybeSingle();
  if (!credentials?.vercel_token) return NextResponse.json({ error: 'Connect a Vercel token to read the failed build logs.' }, { status: 400 });
  let vercelToken: string;
  try { vercelToken = decryptApiKey(credentials.vercel_token); }
  catch { return NextResponse.json({ error: 'Saved Vercel token is invalid. Reconnect it in settings.' }, { status: 400 }); }

  const eventsResponse = await fetch(`https://api.vercel.com/v3/deployments/${encodeURIComponent(deployment.vercel_deployment_id)}/events?limit=100&direction=backward`, { headers: { Authorization: `Bearer ${vercelToken}`, Accept: 'application/json' }, cache: 'no-store' });
  const eventsRaw = await eventsResponse.text();
  if (!eventsResponse.ok) return NextResponse.json({ error: `Could not retrieve Vercel build logs (${eventsResponse.status}).` }, { status: 502 });
  let events: BuildEvent[] = [];
  try {
    const parsed: unknown = eventsRaw ? JSON.parse(eventsRaw) : [];
    if (Array.isArray(parsed)) events = parsed as BuildEvent[];
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { events?: unknown }).events)) events = (parsed as { events: BuildEvent[] }).events;
  } catch { return NextResponse.json({ error: 'Vercel returned unreadable build logs.' }, { status: 502 }); }
  const logs = buildLogText(events);
  if (!logs.trim()) return NextResponse.json({ error: 'No usable build diagnostics were returned by Vercel. Open the deployment logs and inspect the failure manually.' }, { status: 422 });

  const usage = await checkUsageLimit(supabase, user, 'proposal');
  if (!usage.allowed) return NextResponse.json({ error: `Daily proposal limit reached (${usage.limit}).`, usage: usage.usage }, { status: 429 });
  const keys = await loadUserProviderKeys(supabase, user.id);
  const requestedProvider = typeof body.provider === 'string' ? body.provider : undefined;
  const provider = selectProvider(keys, requestedProvider);
  if (!provider) return NextResponse.json({ error: 'No AI provider keys are configured. Open AI Settings and add a key.' }, { status: 400 });
  const keysByProvider: Record<Provider, FailoverKey[]> = {
    cleanapis: (keys.cleanapis ?? []).map((value, index) => ({ id: `cleanapis-key-${index + 1}`, value })),
    gemini: (keys.gemini ?? []).map((value, index) => ({ id: `gemini-key-${index + 1}`, value })),
    groq: (keys.groq ?? []).map((value, index) => ({ id: `groq-key-${index + 1}`, value })),
    openrouter: (keys.openrouter ?? []).map((value, index) => ({ id: `openrouter-key-${index + 1}`, value })),
  };

  const { data: dbFiles, error: filesError } = await supabase.from('project_files').select('path,content').eq('project_id', projectId).order('path');
  if (filesError) return NextResponse.json({ error: filesError.message }, { status: 500 });
  const currentFiles: ProjectFile[] = (dbFiles ?? []).map(file => ({ path: file.path, content: file.content ?? '' }));
  if (!currentFiles.length) return NextResponse.json({ error: 'The project has no files to repair.' }, { status: 400 });

  const context = relevantContext(currentFiles, logs);
  const repairPrompt: AIMessage[] = [
    { role: 'system', content: `You are Nexa's production-build repair agent. The user's Vercel production build has FAILED. Make the smallest real source/config changes needed to fix the compiler/build errors shown below. Inspect related shared types and imports. Do not redesign the app, remove features, disable TypeScript, add @ts-ignore, use any to hide type errors, or change build scripts to bypass checks. Do not touch unrelated files. Output only complete FILE blocks using exactly ---FILE: path/to/file.tsx--- then full file content. If the error is environmental and cannot be fixed in source, return no file blocks and do not invent a code fix.\n\nVERCEL BUILD LOGS:\n${logs}\n\nCURRENT PROJECT FILES:\n${context}` },
    { role: 'user', content: 'Diagnose the actual failed production build and return only the complete changed files required for a proper fix. Preserve existing behavior.' },
  ];
  let responseText = '';
  try {
    await streamWithFailover({ provider, messages: repairPrompt, keys: keysByProvider[provider].map(key => key.value), keysByProvider, mode: 'repair', deadline: Date.now() + 230_000, onChunk: async chunk => { responseText += chunk; } });
  } catch (error) {
    console.error('[NCA VERCEL AUTO-REPAIR AI ERROR]', error);
    return NextResponse.json({ error: 'Nexa could not prepare an AI repair from the Vercel build logs. Check your AI provider keys and try again.' }, { status: 502 });
  }

  const repairedFiles = parseFileBlocks(responseText);
  if (!repairedFiles.length) return NextResponse.json({ error: 'Nexa could not identify a safe source-code repair from the build logs. No project files were changed.' }, { status: 422 });
  const mergedByPath = new Map(currentFiles.map(file => [file.path, file]));
  for (const file of repairedFiles) mergedByPath.set(file.path, file);
  const mergedFiles = [...mergedByPath.values()];
  try { validateProjectPreflight(mergedFiles); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'The proposed repair did not pass static validation.';
    return NextResponse.json({ error: `Nexa's repair did not pass preflight: ${message}. No changes were saved.`, code: 'REPAIR_VALIDATION_FAILED' }, { status: 422 });
  }

  const existingByPath = new Map(currentFiles.map(file => [file.path, file.content]));
  const changes = repairedFiles.filter(file => existingByPath.get(file.path) !== file.content).map(file => ({
    path: file.path,
    operation: existingByPath.has(file.path) ? 'update' : 'create',
    old_content: existingByPath.get(file.path) ?? null,
    new_content: file.content,
  }));
  if (!changes.length) return NextResponse.json({ error: 'Nexa did not produce any effective file changes. No repair proposal was created.' }, { status: 422 });

  const { data: proposal, error: proposalError } = await supabase.from('proposals').insert({ project_id: projectId, user_id: user.id, content: repairedFiles.map(file => `---FILE: ${file.path}---\n${file.content}`).join('\n'), status: 'pending' }).select('id').single();
  if (proposalError || !proposal) return NextResponse.json({ error: proposalError?.message ?? 'Could not save the repair proposal.' }, { status: 500 });
  const changeRows = changes.map(change => ({ proposal_id: proposal.id, ...change }));
  const { error: changeError } = await supabase.from('file_changes').insert(changeRows);
  if (changeError) {
    await supabase.from('proposals').delete().eq('id', proposal.id).eq('user_id', user.id);
    return NextResponse.json({ error: changeError.message }, { status: 500 });
  }
  try { await incrementUsage(supabase, user.id, 'proposal'); }
  catch (error) { console.error('[NCA AUTO-REPAIR USAGE UPDATE]', error); }
  await supabase.from('messages').insert({ project_id: projectId, user_id: user.id, role: 'assistant', content: `Nexa prepared a build-repair proposal from the Vercel diagnostics: ${changes.length} file(s) to modify. Review Changes before applying.` });
  return NextResponse.json({ proposalId: proposal.id, changesCount: changes.length, status: 'pending', applied: false, message: 'Nexa prepared a repair proposal. Review the changes and approve them before applying.' });
}
