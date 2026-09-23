import { decryptApiKey } from '@/lib/ai/crypto';
import type { Provider } from '@/lib/ai/failover';
import type { SupabaseClient } from '@supabase/supabase-js';

export const PROVIDERS: Provider[] = ['gemini', 'groq', 'openrouter'];

export async function loadUserProviderKeys(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from('user_api_keys')
    .select('provider,key_name,api_key')
    .eq('user_id', userId)
    .order('provider')
    .order('key_name');

  if (error) throw new Error(error.message);

  const keysByProvider: Record<Provider, string[]> = { gemini: [], groq: [], openrouter: [] };
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

export function selectProvider(keysByProvider: Record<Provider, string[]>, requested?: string): Provider | null {
  if (requested && PROVIDERS.includes(requested as Provider) && keysByProvider[requested as Provider].length) {
    return requested as Provider;
  }
  return PROVIDERS.find(provider => keysByProvider[provider].length > 0) ?? null;
}
