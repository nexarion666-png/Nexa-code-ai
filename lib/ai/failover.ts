export type Provider = 'gemini' | 'groq' | 'openrouter';
export type AIMessage = { role: 'system' | 'user' | 'assistant'; content: string };

// Keep the live matrix small and explicit. These IDs are current as of Oct 2026.
export const MODELS: Record<Provider, readonly string[]> = {
  gemini: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview'],
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  openrouter: ['google/gemini-3.8-flash', 'google/gemini-3.7-flash', 'google/gemini-3-flash-preview'],
};

const CHAT_OUTPUT_TOKENS = 4096;
const GENERATION_OUTPUT_TOKENS = 32768;
const CHAT_TIMEOUT_MS = 30_000;
const GENERATION_TIMEOUT_MS = 120_000;
const MAX_CONTINUATIONS_CHAT = 1;
const MAX_CONTINUATIONS_GENERATION = 2;
const PROVIDER_COOLDOWN_MS = 60_000;
const MAX_CONTINUATION_CONTEXT_CHARS = 80_000;
const SWITCH_PREFIX = '__NEXA_PROVIDER_SWITCH__:';

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
  isChat?: boolean;
};

type FinishReason = string | null;

type ProviderAttemptResult = {
  text: string;
  finishReason: FinishReason;
  truncated: boolean;
};

type FailureKind = 'auth' | 'quota' | 'busy' | 'timeout' | 'network' | 'model' | 'truncated' | 'empty' | 'provider';

type AttemptFailure = {
  kind: FailureKind;
  message: string;
  status?: number;
};

type ProviderTrace = {
  provider: Provider;
  keysTried: number;
  modelsTried: string[];
  lastError: string;
  failureKinds: FailureKind[];
};

const cooldownUntil: Partial<Record<Provider, number>> = {};

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
  cooldownUntil[provider] = Date.now() + PROVIDER_COOLDOWN_MS;
}

function isCoolingDown(provider: Provider) {
  return (cooldownUntil[provider] ?? 0) > Date.now();
}

function modelsFor(provider: Provider): readonly string[] {
  return MODELS[provider];
}

function outputTokens(isChat: boolean) {
  return isChat ? CHAT_OUTPUT_TOKENS : GENERATION_OUTPUT_TOKENS;
}

function timeoutMs(isChat: boolean) {
  return isChat ? CHAT_TIMEOUT_MS : GENERATION_TIMEOUT_MS;
}

async function assertOk(response: Response, provider: Provider): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw new ProviderError(provider, response.status, text.slice(0, 1200) || `Provider returned ${response.status}`);
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
        const data = event.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    const data = buffer.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (data) yield data;
  } finally {
    reader.releaseLock();
  }
}

function finishReasonIsTruncated(provider: Provider, reason: FinishReason) {
  if (!reason) return false;
  const normalized = reason.toUpperCase();
  return provider === 'gemini'
    ? normalized === 'MAX_TOKENS' || normalized === 'MAX_OUTPUT_TOKENS' || normalized === 'LENGTH'
    : normalized === 'LENGTH' || normalized === 'MAX_TOKENS' || normalized === 'MAX_COMPLETION_TOKENS';
}

function classifyFailure(error: unknown): AttemptFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderError) {
    if (error.status === 401 || error.status === 403) return { kind: 'auth', status: error.status, message };
    if (error.status === 429 || /quota|rate.?limit|too many requests/i.test(message)) return { kind: 'quota', status: error.status, message };
    if (error.status === 404 || /model.*(not found|does not exist)|no endpoints found|not supported for generate/i.test(message)) return { kind: 'model', status: error.status, message };
    if (error.status === 499 || /truncated|output was truncated/i.test(message)) return { kind: 'truncated', status: error.status, message };
    if (error.status === 408 || error.status === 504) return { kind: 'timeout', status: error.status, message };
    if (error.status === 500 || error.status === 502 || error.status === 503) return { kind: 'busy', status: error.status, message };
    return { kind: 'provider', status: error.status, message };
  }
  if (error instanceof Error && error.name === 'AbortError') return { kind: 'timeout', message: 'Provider request timed out.' };
  if (/network|fetch failed|socket|ECONN|ETIMEDOUT|timed out|timeout/i.test(message)) return { kind: 'network', message };
  if (/truncated|length|MAX_TOKENS|MAX_OUTPUT/i.test(message)) return { kind: 'truncated', message };
  return { kind: 'provider', message };
}

function formatFailure(failure: AttemptFailure) {
  return failure.status ? `${failure.kind} (${failure.status}): ${failure.message}` : `${failure.kind}: ${failure.message}`;
}

function isKeyExhaustionKind(kind: FailureKind) {
  return kind === 'auth' || kind === 'quota';
}

function isProviderCooldownKind(kind: FailureKind) {
  return kind === 'busy' || kind === 'timeout' || kind === 'network';
}

async function callProviderStream(attempt: Attempt, messages: AIMessage[]): Promise<ProviderAttemptResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs(Boolean(attempt.isChat)));
  let text = '';
  let finishReason: FinishReason = null;

  try {
    if (attempt.provider === 'gemini') {
      const contents = messages
        .filter(message => message.role !== 'system')
        .map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
      const system = attempt.systemPrompt ?? messages.find(message => message.role === 'system')?.content;
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(attempt.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(attempt.key.value)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents,
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: outputTokens(Boolean(attempt.isChat)),
              ...(attempt.isChat ? { thinkingConfig: { thinkingLevel: 'low' } } : { thinkingConfig: { thinkingLevel: 'medium' } }),
            },
          }),
          signal: controller.signal,
        },
      );
      await assertOk(response, attempt.provider);
      if (!response.body) throw new ProviderError(attempt.provider, 500, 'Streaming response was empty.');
      for await (const payload of readSSE(response.body)) {
        if (payload === '[DONE]') continue;
        try {
          const json: unknown = JSON.parse(payload);
          const candidates = (json as { candidates?: unknown })?.candidates;
          if (!Array.isArray(candidates)) continue;
          const candidate = candidates[0] as { content?: unknown; finishReason?: unknown } | undefined;
          if (typeof candidate?.finishReason === 'string') finishReason = candidate.finishReason;
          const parts = (candidate?.content as { parts?: unknown } | undefined)?.parts;
          if (!Array.isArray(parts)) continue;
          for (const part of parts) {
            if (part && typeof (part as { text?: unknown }).text === 'string') text += (part as { text: string }).text;
          }
        } catch {
          // Ignore malformed provider events; the final finish reason decides success.
        }
      }
    } else {
      const url = attempt.provider === 'groq'
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
      const headers: Record<string, string> = {
        Authorization: `Bearer ${attempt.key.value}`,
        'Content-Type': 'application/json',
      };
      if (attempt.provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://nexa-code-ai.vercel.app';
        headers['X-Title'] = 'Nexa Code AI';
      }
      const maxTokens = outputTokens(Boolean(attempt.isChat));
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: attempt.model,
          messages: messages.map(message => ({ role: message.role, content: message.content })),
          stream: true,
          temperature: 0.2,
          ...(attempt.provider === 'groq' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
        }),
        signal: controller.signal,
      });
      await assertOk(response, attempt.provider);
      if (!response.body) throw new ProviderError(attempt.provider, 500, 'Streaming response was empty.');
      for await (const payload of readSSE(response.body)) {
        if (payload === '[DONE]') continue;
        try {
          const json: unknown = JSON.parse(payload);
          const choices = (json as { choices?: unknown })?.choices;
          if (!Array.isArray(choices)) continue;
          const choice = choices[0] as { delta?: unknown; finish_reason?: unknown } | undefined;
          if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
          const content = (choice?.delta as { content?: unknown } | undefined)?.content;
          if (typeof content === 'string' && content) text += content;
        } catch {
          // Ignore malformed provider events.
        }
      }
    }

    if (!text.trim()) throw new ProviderError(attempt.provider, 502, 'Provider returned an empty response.');
    return { text, finishReason, truncated: finishReasonIsTruncated(attempt.provider, finishReason) };
  } finally {
    clearTimeout(timeout);
  }
}

function continuationMessages(base: AIMessage[], partial: string, isChat: boolean): AIMessage[] {
  const safePartial = partial.length > MAX_CONTINUATION_CONTEXT_CHARS
    ? partial.slice(-MAX_CONTINUATION_CONTEXT_CHARS)
    : partial;
  return [
    ...base,
    { role: 'assistant', content: safePartial },
    {
      role: 'user',
      content: isChat
        ? 'Your response was cut off by the output limit. Continue the answer from exactly where you stopped. Do not restart or repeat the completed text. Finish the answer now.'
        : 'Your code generation was cut off by the output limit. Continue from exactly where you stopped. Do not restart, summarize, or repeat completed files. Finish the current file first, then output every remaining required file using the exact ---FILE: path--- format. Output only file blocks.',
    },
  ];
}

async function runAttempt(attempt: Attempt): Promise<{ text: string; continuationCount: number }> {
  let messages = attempt.messages;
  let combined = '';
  const maxContinuations = attempt.isChat ? MAX_CONTINUATIONS_CHAT : MAX_CONTINUATIONS_GENERATION;

  for (let continuation = 0; continuation <= maxContinuations; continuation += 1) {
    const result = await callProviderStream(attempt, messages);
    combined += result.text;

    if (!result.truncated) {
      return { text: combined, continuationCount: continuation };
    }

    if (continuation >= maxContinuations) {
      throw new ProviderError(attempt.provider, 499, 'Provider output was truncated (length) after continuation attempts.');
    }

    messages = continuationMessages(attempt.messages, combined, Boolean(attempt.isChat));
  }

  throw new ProviderError(attempt.provider, 499, 'Provider output could not be completed.');
}

function makeTrace(provider: Provider): ProviderTrace {
  return { provider, keysTried: 0, modelsTried: [], lastError: '', failureKinds: [] };
}

function traceHasOnlyExhaustionFailures(trace: ProviderTrace) {
  return trace.failureKinds.length > 0 && trace.failureKinds.every(isKeyExhaustionKind);
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
  const fallback: Provider[] = isChat
    ? ['groq', 'gemini', 'openrouter']
    : ['gemini', 'groq', 'openrouter'];
  const order = [requestedProvider, ...fallback].filter((value, index, array): value is Provider => array.indexOf(value) === index);

  return new ReadableStream<string>({
    async start(controller) {
      const tried: ProviderTrace[] = [];
      let lastErr = 'No provider returned a complete response.';
      let allFailuresAreKeyExhaustion = true;

      try {
        for (const provider of order) {
          if (isCoolingDown(provider)) {
            const trace = makeTrace(provider);
            trace.lastError = 'Provider cooldown active';
            trace.failureKinds.push('busy');
            tried.push(trace);
            allFailuresAreKeyExhaustion = false;
            continue;
          }

          const keys = keysByProvider[provider] ?? [];
          if (!keys.length) continue;
          const trace = makeTrace(provider);

          for (const key of keys) {
            trace.keysTried += 1;
            let keyHadSuccess = false;

            for (const model of modelsFor(provider)) {
              trace.modelsTried.push(model);
              const attempt: Attempt = { provider, key, model, messages, systemPrompt, isChat };
              try {
                console.log(`[STREAM TRY] ${provider} ${model} key=${String(key.id).slice(0, 6)} mode=${isChat ? 'chat' : 'generation'}`);
                const result = await runAttempt(attempt);
                keyHadSuccess = true;
                console.log(`[STREAM SUCCESS] ${provider} ${model} output=${result.text.length} continuations=${result.continuationCount}`);
                // A provider attempt is buffered until it completes, so a failed or
                // truncated attempt can never be mixed with another provider's output.
                for (let offset = 0; offset < result.text.length; offset += 4096) {
                  controller.enqueue(result.text.slice(offset, offset + 4096));
                }
                controller.close();
                return;
              } catch (error) {
                const failure = classifyFailure(error);
                lastErr = failure.message;
                trace.lastError = formatFailure(failure);
                trace.failureKinds.push(failure.kind);
                console.error(`[STREAM FAIL] ${provider} ${model}: ${trace.lastError}`);

                if (failure.kind === 'truncated') {
                  // Output-limit failures are model/generation failures, not dead keys.
                  allFailuresAreKeyExhaustion = false;
                  continue;
                }
                if (failure.kind === 'model') {
                  allFailuresAreKeyExhaustion = false;
                  continue;
                }
                if (failure.kind === 'auth' || failure.kind === 'quota') {
                  // Auth/quota is key-scoped. Stop trying models on this key and move
                  // immediately to the next saved key.
                  break;
                }
                if (isProviderCooldownKind(failure.kind)) {
                  allFailuresAreKeyExhaustion = false;
                  startCooldown(provider);
                  controller.enqueue(`${SWITCH_PREFIX}${provider}`);
                  break;
                }
                allFailuresAreKeyExhaustion = false;
              }
            }

            if (isCoolingDown(provider)) break;
            if (keyHadSuccess) break;
          }

          if (trace.failureKinds.length) {
            if (!traceHasOnlyExhaustionFailures(trace)) allFailuresAreKeyExhaustion = false;
            tried.push(trace);
          }
        }

        const payload = JSON.stringify(tried);
        const code = allFailuresAreKeyExhaustion ? 'KEYS_EXHAUSTED' : 'AI_UNAVAILABLE';
        controller.error(new Error(`${code}::${payload}::${lastErr}`));
      } catch (error) {
        controller.error(error);
      }
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
  const stream = createStreamingFailover({ requestedProvider: provider, keysByProvider: allKeys, messages, isChat: false });
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

export function parseFailoverError(message: string) {
  const match = /^(KEYS_EXHAUSTED|AI_UNAVAILABLE)::([\s\S]*?)::([\s\S]*)$/.exec(message);
  if (!match) return null;
  let tried: unknown[] = [];
  try { tried = JSON.parse(match[2]); } catch { /* Keep fallback. */ }
  return { code: match[1] as 'KEYS_EXHAUSTED' | 'AI_UNAVAILABLE', tried, message: match[3] || 'All providers failed.' };
}

export function friendlyFailoverError(messageOrProvider: string | Provider): string {
  const parsed = parseFailoverError(messageOrProvider);
  if (parsed?.code === 'KEYS_EXHAUSTED') {
    return 'All configured AI keys are currently rate-limited or invalid. Wait for cooldown or add another key in Settings.';
  }
  if (parsed?.code === 'AI_UNAVAILABLE') {
    return `AI providers could not complete this request right now. Last error: ${parsed.message}`;
  }
  return `Nexa couldn't complete the request with ${messageOrProvider}. Check provider status, usage limits, and saved keys, then try again.`;
}
