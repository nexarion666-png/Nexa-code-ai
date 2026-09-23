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
  if (!['gemini', 'groq', 'openrouter'].includes(provider) || !apiKey) return NextResponse.json({ error: 'Provider and API key are required.' }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        await streamWithFailover({ provider, messages: [{ role: 'user', content: 'Reply with exactly: Nexa key test successful.' }], keys: [apiKey], onChunk: async chunk => send({ type: 'chunk', text: chunk }) });
        send({ type: 'done' });
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : 'Key test failed.' });
      } finally { controller.close(); }
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
