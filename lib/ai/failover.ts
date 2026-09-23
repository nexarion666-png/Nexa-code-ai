export type Provider = 'gemini' | 'groq' | 'openrouter';
export type FailoverKey = string;

export const FAILOVER_ORDER: Record<Provider, string[]> = {
  gemini: ['gemini-3-flash', 'gemini-3-flash-preview'],
  groq: ['llama-3.3-70b-versatile'],
  openrouter: ['google/gemini-2.0-flash-001'],
};

const FAILED_KEYS = new Map<string, number>();
const COOLDOWN_MS = 60_000;
const TIMEOUT_MS = 8000;

function isFailed(key: string) {
  const failedAt = FAILED_KEYS.get(key);
  if (!failedAt) return false;
  if (Date.now() - failedAt > COOLDOWN_MS) {
    FAILED_KEYS.delete(key);
    return false;
  }
  return true;
}

export async function streamWithFailover(opts: {
  provider: Provider;
  model: string;
  messages: any[];
  keys: string[];
  keysByProvider: Record<Provider, string[]>;
  onChunk: (chunk: string) => Promise<void>;
}) {
  const { provider, messages, keys, keysByProvider, onChunk } = opts;
  let models = FAILOVER_ORDER[provider] || [opts.model];
  let allKeys = keys.filter(k =>!isFailed(k));
  if (allKeys.length === 0) throw new Error('KEYS_EXHAUSTED');

  for (const model of models) {
    for (const key of allKeys) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
        // call provider here - keep your existing logic below
        clearTimeout(timeout);
        return;
      } catch (e) {
        FAILED_KEYS.set(key, Date.now());
      }
    }
  }
  throw new Error('KEYS_EXHAUSTED');
}
