import { decryptApiKey } from '@/lib/ai/crypto';
import type { Provider } from '@/lib/ai/failover';
import type { SupabaseClient } from '@supabase/supabase-js';

export const PROVIDERS: Provider[] = ['cleanapis', 'gemini', 'groq', 'openrouter'];

export function normalizeProviderOrder(value: unknown): Provider[] {
  const input = Array.isArray(value) ? value : [];
  const valid = input.filter((item): item is Provider => typeof item === 'string' && PROVIDERS.includes(item as Provider));
  return [...new Set([...valid, ...PROVIDERS])];
}

export async function loadProviderOrder(supabase: SupabaseClient, userId: string): Promise<Provider[]> {
  const { data, error } = await supabase.from('user_ai_preferences').select('provider_order').eq('user_id', userId).maybeSingle();
  // Keep older deployments working until the preference migration has been applied.
  if (error) return [...PROVIDERS];
  return normalizeProviderOrder(data?.provider_order);
}

export async function loadUserProviderKeys(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from('user_api_keys')
    .select('provider,key_name,api_key')
    .eq('user_id', userId)
    .order('provider')
    .order('key_name');

  if (error) throw new Error(error.message);

  const keysByProvider: Record<Provider, string[]> = { cleanapis: [], gemini: [], groq: [], openrouter: [] };
  for (const row of data ?? []) {
    const provider = row.provider as Provider;
    if (!PROVIDERS.includes(provider)) continue;
    try {
      keysByProvider[provider].push(decryptApiKey(row.api_key));
    } catch {
      // Ignore keys that cannot be decrypted; the user can replace them in Settings.
    }
  }
  return keysByProvider;
}

export function selectProvider(keysByProvider: Record<Provider, string[]>, requested?: string, order: Provider[] = PROVIDERS): Provider | null {
  if (requested && PROVIDERS.includes(requested as Provider) && keysByProvider[requested as Provider].length) {
    return requested as Provider;
  }
  return normalizeProviderOrder(order).find(provider => keysByProvider[provider].length > 0) ?? null;
}
