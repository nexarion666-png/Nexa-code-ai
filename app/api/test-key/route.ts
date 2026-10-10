import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { streamWithFailover, type Provider } from '@/lib/ai/failover';

export const runtime = 'nodejs';

type CodeCraftModel = { id?: unknown; type?: unknown; capabilities?: unknown };
type CodeCraftModelsResponse = { data?: unknown };

function htmlChallenge(contentType: string, body: string): boolean {
  return contentType.includes('text/html') ||
    /<!doctype\s+html|<html[\s>]|just a moment|cloudflare|cf-chl|challenge-platform/i.test(body.slice(0, 4000));
}

function safeErrorMessage(data: any, status: number): string {
  const detail = data?.error?.message ?? data?.message ?? data?.error ?? `HTTP ${status}`;
  return String(detail).replace(/[\r\n]+/g, ' ').slice(0, 400);
}

async function codeCraftRequest(url: string, init: RequestInit): Promise<{ response: Response; text: string; contentType: string }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const text = await response.text();
  return { response, text, contentType };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const provider = String(body.provider ?? '') as Provider;
  const apiKey = String(body.apiKey ?? '').trim();
  if (!['codecraft', 'gemini', 'groq', 'openrouter'].includes(provider) || !apiKey) {
    return NextResponse.json({ error: 'Provider and API key are required.' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        if (provider === 'codecraft') {
          // First check the documented models endpoint. This distinguishes API access,
          // key/scope failures, and Cloudflare challenges from inference/model failures.
          const modelsResult = await codeCraftRequest('https://www.codecraftapi.com/v1/models', {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          });
          const { response: modelsResponse, text: modelsText, contentType: modelsContentType } = modelsResult;

          if (htmlChallenge(modelsContentType, modelsText)) {
            const statusText = modelsResponse.status ? ` (HTTP ${modelsResponse.status})` : '';
            send({ type: 'error', message: `CodeCraft /v1/models returned an HTML/Cloudflare challenge${statusText}, not JSON. The key has NOT been validated. This indicates an endpoint/access challenge; ask CodeCraft support to check server-side API access. Content-Type: ${modelsContentType || 'not provided'}.` });
            return;
          }

          let modelsData: CodeCraftModelsResponse | null = null;
          try { modelsData = JSON.parse(modelsText) as CodeCraftModelsResponse; } catch { /* reported below */ }

          if (!modelsResponse.ok) {
            let parsed: any = modelsData;
            send({ type: 'error', message: `CodeCraft models check failed (${modelsResponse.status}): ${safeErrorMessage(parsed, modelsResponse.status)}` });
            return;
          }
          if (!modelsData || !Array.isArray(modelsData.data)) {
            send({ type: 'error', message: `CodeCraft /v1/models returned HTTP ${modelsResponse.status}, but the body was not the documented JSON model list. Content-Type: ${modelsContentType || 'not provided'}.` });
            return;
          }

          const models = (modelsData.data as CodeCraftModel[])
            .filter(model => typeof model?.id === 'string' && model.id.trim())
            .filter(model => !model.type || model.type === 'chat');
          if (!models.length) {
            send({ type: 'error', message: 'CodeCraft accepted the models request, but no available chat model was listed. Check model access and API key scopes.' });
            return;
          }

          // Prefer the documented example when it is actually listed; otherwise use
          // a model returned by this key instead of hardcoding a potentially unavailable ID.
          const selected = models.find(model => model.id === 'claude-opus-4.8') ?? models[0];
          const modelId = String(selected.id);

          const completionResult = await codeCraftRequest('https://www.codecraftapi.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              model: modelId,
              messages: [{ role: 'user', content: 'Reply with exactly: Nexa key test successful.' }],
              stream: false,
              max_tokens: 24,
              temperature: 0,
            }),
          });
          const { response, text: responseText, contentType } = completionResult;

          if (htmlChallenge(contentType, responseText)) {
            send({ type: 'error', message: `CodeCraft listed models successfully, but chat completions returned an HTML/Cloudflare challenge (HTTP ${response.status}). The key can access /v1/models, but inference has NOT been validated. Content-Type: ${contentType || 'not provided'}. Ask CodeCraft support to check chat-completions access.` });
            return;
          }

          let data: any = null;
          try { data = JSON.parse(responseText); } catch { /* handled below */ }
          if (!response.ok) {
            send({ type: 'error', message: `CodeCraft inference test failed (${response.status}) using model "${modelId}": ${safeErrorMessage(data, response.status)}` });
          } else if (typeof data?.choices?.[0]?.message?.content === 'string') {
            send({ type: 'chunk', text: data.choices[0].message.content });
            send({ type: 'done', model: modelId, modelsAvailable: models.length });
          } else {
            send({ type: 'error', message: `CodeCraft returned HTTP ${response.status}, but not a recognizable chat-completions response for model "${modelId}". Content-Type: ${contentType || 'not provided'}.` });
          }
        } else {
          await streamWithFailover({
            provider,
            messages: [{ role: 'user', content: 'Reply with exactly: Nexa key test successful.' }],
            keys: [apiKey],
            onChunk: async chunk => send({ type: 'chunk', text: chunk }),
          });
          send({ type: 'done' });
        }
      } catch (error) {
        const message = error instanceof Error && error.name === 'TimeoutError'
          ? 'The provider key test timed out after 15 seconds.'
          : error instanceof Error
            ? error.message.slice(0, 500)
            : 'Key test failed.';
        send({ type: 'error', message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
