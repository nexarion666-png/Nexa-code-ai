export type Provider = 'gemini' | 'groq' | 'openrouter';
export type AIMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export const MODELS: Record<Provider, readonly string[]> = {
  gemini: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview'],
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  openrouter: ['google/gemini-3.8-flash', 'google/gemini-3.7-flash', 'google/gemini-3-flash-preview'],
};

const CHAT_OUTPUT_TOKENS = 4096;
const GENERATION_OUTPUT_TOKENS = 32768;
const CHAT_TIMEOUT_MS = 30_000;
const GENERATION_TIMEOUT_MS = 120_000;
const MAX_CONTINUATIONS = 3;

export class ProviderError extends Error {
  constructor(public provider: Provider, public status: number, message: string, public code?: string, public partialOutput = '') {
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

function startCooldown(provider: Provider, seconds = 60) {
  cooldownUntil[provider] = Date.now() + seconds * 1000;
}

function modelsFor(provider: Provider): readonly string[] {
  return MODELS[provider];
}

async function assertOk(response: Response, provider: Provider): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw new ProviderError(provider, response.status, text.slice(0, 1000) || `Provider returned ${response.status}`);
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

function isTruncationReason(value: unknown): boolean {
  return typeof value === 'string' && /^(length|max_tokens|max_tokens_exceeded|MAX_TOKENS)$/i.test(value);
}

async function* callProviderStream(attempt: Attempt, mode: 'chat' | 'generation' = 'chat'): AsyncGenerator<string> {
  const controller = new AbortController();
  const timeoutMs = mode === 'generation' ? GENERATION_TIMEOUT_MS : CHAT_TIMEOUT_MS;
  let timeout = setTimeout(() => controller.abort(), timeoutMs);
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), timeoutMs);
  };
  let partial = '';

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
            generationConfig: { temperature: 0.2, maxOutputTokens: mode === 'generation' ? GENERATION_OUTPUT_TOKENS : CHAT_OUTPUT_TOKENS },
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
          const candidate = candidates[0] as { content?: unknown; finishReason?: unknown };
          const content = candidate?.content as { parts?: unknown } | undefined;
          const parts = content?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              const text = part && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '';
              if (text) {
                partial += text;
                yield text;
              }
            }
          }
          if (isTruncationReason(candidate?.finishReason)) {
            throw new ProviderError(attempt.provider, 499, 'Provider output was truncated (length).', 'TRUNCATED_OUTPUT', partial);
          }
        } catch (error) {
          if (error instanceof ProviderError) throw error;
        }
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
    const outputTokens = mode === 'generation' ? GENERATION_OUTPUT_TOKENS : CHAT_OUTPUT_TOKENS;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: attempt.model,
        messages: attempt.messages.map(message => ({ role: message.role, content: message.content })),
        stream: true,
        temperature: 0.2,
        max_tokens: outputTokens,
        max_completion_tokens: outputTokens,
      }),
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
        const choice = choices[0] as { delta?: unknown; finish_reason?: unknown };
        const delta = choice?.delta as { content?: unknown } | undefined;
        const content = typeof delta?.content === 'string' ? delta.content : '';
        if (content) {
          partial += content;
          yield content;
        }
        if (isTruncationReason(choice?.finish_reason)) {
          throw new ProviderError(attempt.provider, 499, 'Provider output was truncated (length).', 'TRUNCATED_OUTPUT', partial);
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ProviderError(attempt.provider, 408, 'Provider request timed out.', 'TIMEOUT', partial);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isCooldownError(error: unknown): boolean {
  if (error instanceof ProviderError) return error.status === 429 || error.status === 408 || /quota|rate.?limit|too many requests|temporarily unavailable|high demand/i.test(error.message);
  return error instanceof Error && (error.name === 'AbortError' || /network|fetch failed|timed out|timeout|socket|ECONN/i.test(error.message));
}

function isDeadKeyError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return error.status === 401 || error.status === 403 || error.status === 429 || /quota|rate.?limit|invalid api key|unauthorized/i.test(error.message);
}

function isModelError(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 404;
}

async function collectAttempt(attempt: Attempt, mode: 'chat' | 'generation'): Promise<string> {
  let output = '';
  for await (const chunk of callProviderStream(attempt, mode)) output += chunk;
  return output;
}

async function continueGeneration(attempt: Attempt, partial: string): Promise<string> {
  let combined = partial;
  for (let i = 0; i < MAX_CONTINUATIONS; i++) {
    const messages: AIMessage[] = [
      ...attempt.messages,
      { role: 'assistant', content: combined },
      { role: 'user', content: 'Continue exactly from where you stopped. Do not repeat any content already produced. Finish the remaining output completely. Preserve the exact file-block format.' },
    ];
    const continuationAttempt = { ...attempt, messages };
    try {
      const part = await collectAttempt(continuationAttempt, 'generation');
      combined += part;
      if (part.length === 0) break;
      return combined;
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'TRUNCATED_OUTPUT' && error.partialOutput) {
        combined += error.partialOutput;
        continue;
      }
      throw error;
    }
  }
  return combined;
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
    ? [requestedProvider, 'groq', 'gemini', 'openrouter']
    : [requestedProvider, 'gemini', 'groq', 'openrouter'];
  const uniqueOrder = order.filter((provider, index) => order.indexOf(provider) === index);

  return new ReadableStream<string>({
    async start(controller) {
      const tried: { provider: Provider; keysTried: number; modelsTried: string[]; lastError: string }[] = [];
      let lastErr = 'Unknown provider error';

      for (const provider of uniqueOrder) {
        if ((cooldownUntil[provider] ?? 0) > Date.now()) {
          tried.push({ provider, keysTried: 0, modelsTried: [], lastError: 'Provider cooldown active' });
          lastErr = 'Provider cooldown active';
          continue;
        }
        const keys = keysByProvider[provider] ?? [];
        const models = modelsFor(provider);
        const providerTried = { provider, keysTried: 0, modelsTried: [] as string[], lastError: '' };
        if (!keys.length) continue;

        for (const key of keys) {
          providerTried.keysTried += 1;
          for (const model of models) {
            providerTried.modelsTried.push(model);
            const attempt: Attempt = { provider, key, model, messages, systemPrompt };
            try {
              console.log(`[STREAM TRY] ${provider} ${model} key=${key.id.slice(0, 6)}`);
              const providerStream = callProviderStream(attempt, isChat ? 'chat' : 'generation');
              for await (const chunk of providerStream) controller.enqueue(chunk);
              controller.close();
              console.log(`[STREAM SUCCESS] ${provider} ${model}`);
              return;
            } catch (error) {
              lastErr = error instanceof Error ? error.message : String(error);
              providerTried.lastError = lastErr;
              console.error(`[STREAM FAIL] ${provider} ${model}: ${lastErr}`);
              controller.enqueue(`${SWITCH_PREFIX}${provider}`);
              if (isCooldownError(error)) {
                startCooldown(provider, error instanceof ProviderError && error.status === 408 ? 20 : 60);
                break;
              }
              if (isDeadKeyError(error)) break;
              if (isModelError(error)) continue;
              if (error instanceof ProviderError && error.code === 'TRUNCATED_OUTPUT') continue;
            }
          }
          if ((cooldownUntil[provider] ?? 0) > Date.now()) break;
        }
        tried.push(providerTried);
      }

      const payload = JSON.stringify(tried);
      controller.error(new Error(`AI_UNAVAILABLE::${payload}::${lastErr}`));
    },
  });
}

export async function streamWithFailover({
  provider,
  messages,
  keys,
  keysByProvider,
  onChunk,
  mode = 'chat',
}: {
  provider: Provider;
  messages: AIMessage[];
  keys: string[] | FailoverKey[];
  keysByProvider?: Record<Provider, FailoverKey[]>;
  onChunk: (chunk: string) => void | Promise<void>;
  mode?: 'chat' | 'generation';
}): Promise<void> {
  const normalize = (items: string[] | FailoverKey[]) => items.map((item, index) => typeof item === 'string' ? { id: `${provider}-${index + 1}`, value: item } : item);
  const allKeys: Record<Provider, FailoverKey[]> = keysByProvider ?? { gemini: [], groq: [], openrouter: [] };
  if (!keysByProvider) allKeys[provider] = normalize(keys);
  if (!allKeys[provider]?.length) throw new Error('AI_UNAVAILABLE::[]::No configured key for requested provider');

  const orderedProviders: Provider[] = [provider, 'gemini', 'groq', 'openrouter'].filter((p, i, arr): p is Provider => arr.indexOf(p) === i) as Provider[];
  let lastError = 'All providers failed';
  const tried: { provider: Provider; keysTried: number; modelsTried: string[]; lastError: string }[] = [];

  for (const currentProvider of orderedProviders) {
    const providerKeys = allKeys[currentProvider] ?? [];
    if (!providerKeys.length || (cooldownUntil[currentProvider] ?? 0) > Date.now()) continue;
    const models = modelsFor(currentProvider);
    const info = { provider: currentProvider, keysTried: 0, modelsTried: [] as string[], lastError: '' };

    for (const key of providerKeys) {
      info.keysTried += 1;
      for (const model of models) {
        info.modelsTried.push(model);
        const attempt: Attempt = { provider: currentProvider, key, model, messages };
        try {
          console.log(`[STREAM TRY] ${currentProvider} ${model} key=${key.id.slice(0, 6)}`);
          let output = '';
          try {
            output = await collectAttempt(attempt, mode);
          } catch (error) {
            if (!(error instanceof ProviderError) || error.code !== 'TRUNCATED_OUTPUT' || !error.partialOutput || mode !== 'generation') throw error;
            console.warn(`[STREAM CONTINUE] ${currentProvider} ${model} truncated at ${error.partialOutput.length} chars; continuing.`);
            output = await continueGeneration(attempt, error.partialOutput);
          }
          if (!output.trim()) throw new ProviderError(currentProvider, 502, 'Provider returned an empty response.', 'EMPTY_OUTPUT');
          await onChunk(output);
          console.log(`[STREAM SUCCESS] ${currentProvider} ${model}`);
          return;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          info.lastError = lastError;
          console.error(`[STREAM FAIL] ${currentProvider} ${model}: ${lastError}`);
          if (isCooldownError(error)) {
            startCooldown(currentProvider, error instanceof ProviderError && error.status === 408 ? 20 : 60);
            break;
          }
          if (isDeadKeyError(error)) break;
        }
      }
      if ((cooldownUntil[currentProvider] ?? 0) > Date.now()) break;
    }
    tried.push(info);
  }

  throw new Error(`AI_UNAVAILABLE::${JSON.stringify(tried)}::${lastError}`);
}

export function parseFailoverError(message: string): {
  code: string;
  tried: unknown[];
  message: string;
} {
  const match = message.match(/^(KEYS_EXHAUSTED|AI_UNAVAILABLE)::(.*?)::([\s\S]*)$/);
  if (!match) return { code: 'AI_UNAVAILABLE', tried: [], message };
  let tried: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(match[2]);
    if (Array.isArray(parsed)) tried = parsed;
  } catch {
    // Keep a safe empty fallback for malformed provider diagnostics.
  }
  return { code: match[1], tried, message: match[3] || 'All providers failed' };
}

export function friendlyFailoverError(messageOrProvider: string | Provider): string {
  if (messageOrProvider.startsWith('KEYS_EXHAUSTED::')) return 'Your configured AI keys are exhausted or rate-limited. Add another key or wait for provider cooldown.';
  if (messageOrProvider.startsWith('AI_UNAVAILABLE::')) return 'Nexa could not complete the request with the currently available AI providers. Try again shortly.';
  return `Nexa couldn't connect with any available ${messageOrProvider} provider. Check the saved keys and provider status, then try again.`;
}
