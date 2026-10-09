import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { streamWithFailover, type Provider } from '@/lib/ai/failover';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const provider = String(body.provider ?? '') as Provider;
  const apiKey = String(body.apiKey ?? '').trim();
  if (!['codecraft', 'gemini', 'groq', 'openrouter'].includes(provider) || !apiKey) return NextResponse.json({ error: 'Provider and API key are required.' }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        if (provider === 'codecraft') {
          // Settings key test is a direct, non-streaming API check. This isolates
          // key/endpoint validation from Nexa's normal streaming/failover path.
          const response = await fetch('https://www.codecraftapi.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              model: 'claude-opus-4.8',
              messages: [{ role: 'user', content: 'Reply with exactly: Nexa key test successful.' }],
              stream: false,
              max_tokens: 32,
              temperature: 0,
            }),
            signal: AbortSignal.timeout(15000),
          });
          const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
          const responseText = await response.text();
          if (contentType.includes('text/html') || /<html[\s>]|just a moment|cloudflare|cf-chl|challenge-platform/i.test(responseText.slice(0, 2500))) {
            send({ type: 'error', message: 'CodeCraft returned an HTML/Cloudflare challenge from the documented www API hostname. The key has not been validated; this is an endpoint/access response, not proof that the key is invalid.' });
          } else {
            let data: any = null;
            try { data = JSON.parse(responseText); } catch { /* handled below */ }
            if (!response.ok) {
              const detail = data?.error?.message ?? data?.message ?? `HTTP ${response.status}`;
              send({ type: 'error', message: `CodeCraft API test failed (${response.status}): ${String(detail).slice(0, 400)}` });
            } else if (typeof data?.choices?.[0]?.message?.content === 'string') {
              send({ type: 'chunk', text: data.choices[0].message.content });
              send({ type: 'done' });
            } else {
              send({ type: 'error', message: 'CodeCraft returned JSON, but not a recognizable chat-completions response. Check the API compatibility and model name.' });
            }
          }
        } else {
          await streamWithFailover({ provider, messages: [{ role: 'user', content: 'Reply with exactly: Nexa key test successful.' }], keys: [apiKey], onChunk: async chunk => send({ type: 'chunk', text: chunk }) });
          send({ type: 'done' });
        }
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : 'Key test failed.' });
      } finally { controller.close(); }
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
