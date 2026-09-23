export type Provider = 'gemini' | 'groq' | 'openrouter';
export type AIMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export const MODELS: Record<Provider, readonly string[]> = {
  gemini: ['gemini-3-flash', 'gemini-3-flash-preview'],
  groq: ['llama-3.3-70b-versatile'],
  openrouter: ['google/gemini-2.0-flash-001'],
};

export class ProviderError extends Error {
  constructor(public provider: Provider, public status: number, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type FailoverKey = { id: string; value: string };

type Attempt = {
  provider: Provider;
  key: FailoverKey;
  model: string;
  messages: AIMessage[];
  systemPrompt?: string;
};

const cooldownUntil: Record<string, number> = {};
const SWITCH_PREFIX = '__NEXA_PROVIDER_SWITCH__:';

export type CooldownStatus = Record<Provider, { cooldownUntil: number; cooldownSeconds: number }>;

export function getCooldownStatus(): CooldownStatus {
  const now = Date.now();
  return {
    gemini: { cooldownUntil: cooldownUntil.gemini ?? 0, cooldownSeconds: Math.max(0, Math.ceil(((cooldownUntil.gemini ?? 0) - now) / 1000)) },
    groq: { cooldownUntil: cooldownUntil.groq ?? 0, cooldownSeconds: Math.max(0, Math.ceil(((cooldownUntil.groq ?? 0) - now) / 1000)) },
    openrouter: { cooldownUntil: cooldownUntil.openrouter ?? 0, cooldownSeconds: Math.max(0, Math.ceil(((cooldownUntil.openrouter ?? 0) - now) / 1000)) },
  };
}

function startCooldown(provider: Provider) {
  cooldownUntil[provider] = Date.now() + 60_000;
}

function modelsFor(provider: Provider): readonly string[] {
  return MODELS[provider];
}

async function assertOk(response: Response, provider: Provider): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw new ProviderError(provider, response.status, text.slice(0, 500) || `Provider returned ${response.status}`);
}

async function* readSSE(body: ReadableStream<Uint8Array>, onActivity?: () => void): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) yield data;
  } finally {
    reader.releaseLock();
  }
}

async function* callProviderStream(attempt: Attempt): AsyncGenerator<string> {
  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(), 8_000);
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), 8_000);
  };

  try {
    if (attempt.provider === 'gemini') {
      const contents = attempt.messages
        .filter(message => message.role !== 'system')
        .map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
      const system = attempt.systemPrompt ?? attempt.messages.find(message => message.role === 'system')?.content;
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(attempt.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(attempt.key.value)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents,
            generationConfig: { temperature: 0.2 },
          }),
          signal: controller.signal,
        },
      );
      await assertOk(response, attempt.provider);
      if (!response.body) throw new ProviderError(attempt.provider, 500, 'Streaming response was empty.');
      for await (const payload of readSSE(response.body, resetTimeout)) {
        if (payload === '[DONE]') continue;
        try {
          const json: unknown = JSON.parse(payload);
          const candidates = (json as { candidates?: unknown })?.candidates;
          if (!Array.isArray(candidates)) continue;
          const content = (candidates[0] as { content?: unknown })?.content;
          const parts = (content as { parts?: unknown })?.parts;
          if (!Array.isArray(parts)) continue;
          for (const part of parts) if (part && typeof (part as { text?: unknown }).text === 'string') yield (part as { text: string }).text;
        } catch { /* Ignore malformed provider events. */ }
      }
      return;
    }

    const url = attempt.provider === 'groq'
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions';
    const headers: Record<string, string> = { Authorization: `Bearer ${attempt.key.value}`, 'Content-Type': 'application/json' };
    if (attempt.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://nexa-code-ai.vercel.app';
      headers['X-Title'] = 'Nexa Code AI';
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: attempt.model, messages: attempt.messages.map(message => ({ role: message.role, content: message.content })), stream: true, temperature: 0.2 }),
      signal: controller.signal,
    });
    await assertOk(response, attempt.provider);
    if (!response.body) throw new ProviderError(attempt.provider, 500, 'Streaming response was empty.');
    for await (const payload of readSSE(response.body, resetTimeout)) {
      if (payload === '[DONE]') continue;
      try {
        const json: unknown = JSON.parse(payload);
        const choices = (json as { choices?: unknown })?.choices;
        if (!Array.isArray(choices)) continue;
        const delta = (choices[0] as { delta?: unknown })?.delta;
        const content = (delta as { content?: unknown })?.content;
        if (typeof content === 'string' && content) yield content;
      } catch { /* Ignore malformed provider events. */ }
    }
  } finally {
    clearTimeout(timeout);
  }
}

function isCooldownError(error: unknown): boolean {
  if (error instanceof ProviderError) return error.status === 429 || /quota|rate.?limit|too many requests/i.test(error.message);
  return error instanceof Error && (error.name === 'AbortError' || /network|fetch failed|timed out|timeout|socket|ECONN/i.test(error.message));
}

export function createStreamingFailover({
  requestedProvider = 'gemini',
  keysByProvider,
  messages,
  systemPrompt,
  isChat = false,
}: {
  requestedProvider?: Provider;
  keysByProvider: Record<string, FailoverKey[]>;
  messages: AIMessage[];
  systemPrompt?: string;
  isChat?: boolean;
}): ReadableStream<string> {
  const order: Provider[] = isChat
    ? ['groq', 'gemini', 'openrouter']
    : ['gemini', 'groq', 'openrouter'];

  return new ReadableStream<string>({
    async start(controller) {
      const tried: { provider: Provider; keysTried: number; modelsTried: string[]; lastError: string }[] = [];
      let lastErr = 'Unknown provider error';

      for (const provider of order) {
        if ((cooldownUntil[provider] ?? 0) > Date.now()) continue;
        const keys = keysByProvider[provider] ?? [];
        const models = modelsFor(provider);
        const providerTried = { provider, keysTried: 0, modelsTried: [] as string[], lastError: '' };

        for (const key of keys) {
          providerTried.keysTried += 1;
          for (const model of models) {
            providerTried.modelsTried.push(model);
            const attempt: Attempt = { provider, key, model, messages, systemPrompt };
            try {
              console.log(`[STREAM TRY] ${provider} ${model} key=${key.id.slice(0, 6)}`);
              const providerStream = callProviderStream(attempt);
              for await (const chunk of providerStream) controller.enqueue(chunk);
              controller.close();
              console.log(`[STREAM SUCCESS] ${provider} ${model}`);
              return;
            } catch (error) {
              lastErr = error instanceof Error ? error.message : String(error);
              providerTried.lastError = lastErr;
              console.error(`[STREAM FAIL] ${provider} ${model}: ${lastErr}`);
              if (isCooldownError(error)) startCooldown(provider);
              controller.enqueue(`${SWITCH_PREFIX}${provider}`);
            }
          }
        }
        tried.push(providerTried);
      }

      const payload = JSON.stringify(tried);
      controller.error(new Error(`KEYS_EXHAUSTED::${payload}::${lastErr}`));
    },
  });
}

export async function streamWithFailover({
  provider,
  messages,
  keys,
  keysByProvider,
  onChunk,
}: {
  provider: Provider;
  messages: AIMessage[];
  keys: string[];
  keysByProvider?: Record<Provider, FailoverKey[]>;
  onChunk: (chunk: string) => void | Promise<void>;
}): Promise<void> {
  const allKeys: Record<Provider, FailoverKey[]> = keysByProvider ?? { gemini: [], groq: [], openrouter: [] };
  if (!keysByProvider) allKeys[provider] = keys.slice(0, 3).map((value, index) => ({ id: `${provider}-${index + 1}`, value }));
  const stream = createStreamingFailover({ requestedProvider: provider, keysByProvider: allKeys, messages });
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value.startsWith(SWITCH_PREFIX)) continue;
      await onChunk(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export function friendlyFailoverError(messageOrProvider: string | Provider): string {
  return messageOrProvider.startsWith('KEYS_EXHAUSTED::')
    ? 'All configured AI keys are currently exhausted or unavailable. Please wait for cooldown or add a key in Settings.'
    : `Nexa couldn't connect with any of your ${messageOrProvider} keys. Check the saved keys, usage limits, and provider status, then try again.`;
}
