import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptApiKey } from '@/lib/ai/crypto';
import { createStreamingFailover, friendlyFailoverError, type AIMessage, type FailoverKey, type Provider } from '@/lib/ai/failover';
import { checkUsageLimit, incrementUsage } from '@/lib/limits';

export const runtime = 'nodejs';

const CONVERSATION_SYSTEM = `You are Nexa Code AI in Conversation Mode. Ask clarifying questions when the request is vague or important requirements are missing. Do NOT write code yet. When you have enough information, output [PROPOSAL_READY].`;

const MAX_FILE_LIST = 60;
const MAX_FILE_CHARS = 3200;
const MAX_CONTEXT_CHARS = 24000;

function isSpecificEditRequest(message: string): boolean {
  const text = message.toLowerCase().trim();
  if (!text) return false;
  const editVerb = /\b(change|update|edit|modify|fix|make|adjust|tweak|replace|remove|delete|add|hide|show|rename|move|restyle|style|color|colour|resize|align|center|centre|improve|polish|swap)\b/i;
  const concreteTarget = /\b(button|header|navbar|nav|footer|card|page|route|form|input|modal|menu|tab|icon|text|title|logo|background|border|font|color|colour|layout|spacing|padding|margin|wishlist|dashboard|login|signup|settings|github|deploy|preview)\b/i;
  const broadBuild = /\b(build|create|generate|start|make me|new project|from scratch)\b/i;
  return editVerb.test(text) && concreteTarget.test(text) && !broadBuild.test(text);
}

function buildProjectContext(files: { path: string; content: string | null }[]): string {
  if (!files.length) return '\nNo project files exist yet.';
  const list = files.slice(0, MAX_FILE_LIST).map(file => file.path).join('\n');
  let remaining = MAX_CONTEXT_CHARS;
  const excerpts: string[] = [];
  for (const file of files) {
    if (remaining <= 0) break;
    const content = String(file.content ?? '');
    if (!content) continue;
    const excerpt = content.slice(0, Math.min(MAX_FILE_CHARS, remaining));
    remaining -= excerpt.length;
    excerpts.push(`---FILE: ${file.path}---\n${excerpt}${content.length > excerpt.length ? '\n[truncated]' : ''}`);
  }
  return `\nPROJECT FILE LIST:\n${list}${files.length > MAX_FILE_LIST ? `\n[${files.length - MAX_FILE_LIST} more files omitted]` : ''}\n\nPROJECT FILE CONTENT (capped excerpts):\n${excerpts.join('\n')}`;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const projectId = String(body.projectId ?? '');
  const message = String(body.message ?? '').trim();
  const history = Array.isArray(body.history) ? body.history : [];
  if (!projectId || !message) return NextResponse.json({ error: 'projectId and message are required.' }, { status: 400 });

  const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', user.id).single();
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const { data: projectFiles, error: projectFilesError } = await supabase
    .from('project_files')
    .select('path,content')
    .eq('project_id', projectId)
    .order('path');
  if (projectFilesError) return NextResponse.json({ error: projectFilesError.message }, { status: 500 });
  const existingFiles = (projectFiles ?? []) as { path: string; content: string | null }[];
  const editMode = existingFiles.length > 0 && isSpecificEditRequest(message);
  const projectContext = buildProjectContext(existingFiles);
  const SYSTEM = editMode
    ? `You are Nexa Code AI in EDIT MODE. The user has an existing project and made a concrete edit request. You can see the project file list and capped file excerpts below. Do not conduct a multi-question interview. If the request is implementable from the available context, respond with ONE concise plan sentence followed by [PROPOSAL_READY]. Ask a question only if a missing detail would materially change the implementation. Do not write code yet.${projectContext}`
    : `${CONVERSATION_SYSTEM}${projectContext}`;

  const usageCheck = await checkUsageLimit(supabase, user, 'message');
  if (!usageCheck.allowed) return NextResponse.json({ error: `Daily message limit reached (${usageCheck.limit}). Upgrade to Pro for unlimited messages.`, usage: usageCheck.usage }, { status: 429 });
  try { await incrementUsage(supabase, user.id, 'message'); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not update usage.' }, { status: 500 }); }

  const { data: keyRows, error: keyError } = await supabase.from('user_api_keys').select('provider,key_name,api_key').eq('user_id', user.id).order('key_name');
  if (keyError) return NextResponse.json({ error: keyError.message }, { status: 500 });
  const keysByProvider: Record<Provider, FailoverKey[]> = { gemini: [], groq: [], openrouter: [] };
  for (const row of keyRows ?? []) {
    if (!(row.provider in keysByProvider)) continue;
    try { keysByProvider[row.provider as Provider].push({ id: String(row.key_name || `key-${keysByProvider[row.provider as Provider].length + 1}`), value: decryptApiKey(row.api_key) }); } catch { /* Ignore an invalid old key. */ }
  }
  const requestedProvider = String(body.provider || 'gemini') as Provider;
  const provider: Provider = ['gemini', 'groq', 'openrouter'].includes(requestedProvider) && keysByProvider[requestedProvider].length ? requestedProvider : (['gemini', 'groq', 'openrouter'] as Provider[]).find(p => keysByProvider[p].length > 0) ?? requestedProvider;
  if (!['gemini', 'groq', 'openrouter'].includes(provider)) return NextResponse.json({ error: 'Unsupported provider.' }, { status: 400 });
  if (!keysByProvider[provider].length) return NextResponse.json({ error: 'No AI provider keys are configured. Open AI Settings and add a key.' }, { status: 400 });

  const safeHistory: AIMessage[] = history.slice(-30).filter((m: unknown): m is { role: string; content: string } => {
    if (!m || typeof m !== 'object') return false;
    const candidate = m as { role?: unknown; content?: unknown };
    return (candidate.role === 'user' || candidate.role === 'assistant') && typeof candidate.content === 'string';
  }).map((m: { role: 'user' | 'assistant'; content: string }) => ({ role: m.role, content: m.content }));
  const messages: AIMessage[] = [{ role: 'system', content: SYSTEM }, ...safeHistory, { role: 'user', content: message }];

  const { error: saveUserError } = await supabase.from('messages').insert({ project_id: projectId, user_id: user.id, role: 'user', content: message });
  if (saveUserError) return NextResponse.json({ error: saveUserError.message }, { status: 500 });

  const encoder = new TextEncoder();
  const failoverStream = createStreamingFailover({ requestedProvider: provider, keysByProvider, messages, systemPrompt: SYSTEM, isChat: true, outputTokens: 3072 });
  const reader = failoverStream.getReader();
  let first: ReadableStreamReadResult<string>;
  try {
    first = await reader.read();
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (raw.startsWith('KEYS_EXHAUSTED::')) {
      const [, triedJson = '[]', lastErr = 'All providers failed'] = raw.split('::');
      let tried: unknown[] = [];
      try { tried = JSON.parse(triedJson); } catch { /* Keep UI-safe fallback. */ }
      console.error('[NEXA KEYS_EXHAUSTED]', error);
      reader.releaseLock();
      return Response.json({ error: 'KEYS_EXHAUSTED', tried, message: lastErr, retryAfter: 60 }, { status: 429 });
    }
    console.error('[NEXA CHAT ERROR]', error);
    reader.releaseLock();
    return Response.json({ error: friendlyFailoverError(raw) }, { status: 502 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      let full = '';
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        let pending = first;
        while (true) {
          if (pending.done) break;
          const value = pending.value;
          if (value.startsWith('__NEXA_PROVIDER_SWITCH__:')) {
            send({ type: 'switching', provider: value.slice('__NEXA_PROVIDER_SWITCH__:'.length) });
          } else {
            full += value;
            send({ type: 'chunk', text: value });
          }
          pending = await reader.read();
        }
        const { error: saveAssistantError } = await supabase.from('messages').insert({ project_id: projectId, user_id: user.id, role: 'assistant', content: full });
        if (saveAssistantError) send({ type: 'warning', message: 'Response streamed, but Nexa could not save it to history.' });
        send({ type: 'done', proposalReady: editMode || full.includes('[PROPOSAL_READY]') });
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        if (raw.startsWith('KEYS_EXHAUSTED::')) {
          const [, triedJson = '[]', lastErr = 'All providers failed'] = raw.split('::');
          let tried: unknown[] = [];
          try { tried = JSON.parse(triedJson); } catch { /* Keep UI-safe fallback. */ }
          console.error('[NEXA KEYS_EXHAUSTED]', error);
          send({ type: 'keys_exhausted', error: 'KEYS_EXHAUSTED', tried, message: lastErr, retryAfter: 60 });
        } else {
          console.error('[NEXA CHAT ERROR]', error);
          send({ type: 'error', message: friendlyFailoverError(raw) });
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
}
