import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptApiKey } from '@/lib/ai/crypto';
import { createStreamingFailover, friendlyFailoverError, type AIMessage, type FailoverKey, type Provider } from '@/lib/ai/failover';
import { checkUsageLimit, incrementUsage } from '@/lib/limits';

export const runtime = 'nodejs';

const SYSTEM = `You are Nexa Code AI in Conversation Mode. You MUST ask clarifying questions about project requirements, tech stack, features, design before proposing. Do NOT write code yet. Goal is to understand fully. When you have enough info, output [PROPOSAL_READY] marker.`;

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
  const failoverStream = createStreamingFailover({ requestedProvider: provider, keysByProvider, messages, systemPrompt: SYSTEM, isChat: true });
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
        send({ type: 'done', proposalReady: full.includes('[PROPOSAL_READY]') });
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
