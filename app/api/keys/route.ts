import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encryptApiKey } from '@/lib/ai/crypto';

const providers = ['gemini', 'groq', 'openrouter'] as const;

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await supabase.from('user_api_keys').select('id,provider,key_name,created_at').eq('user_id', user.id).order('key_name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ keys: data ?? [] });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const provider = String(body.provider ?? '');
  const keyName = String(body.keyName ?? '');
  const apiKey = String(body.apiKey ?? '').trim();
  if (!providers.includes(provider as typeof providers[number]) || !['Key 1', 'Key 2', 'Key 3'].includes(keyName)) return NextResponse.json({ error: 'Invalid provider or key name.' }, { status: 400 });

  if (!apiKey) {
    const { error } = await supabase.from('user_api_keys').delete().eq('user_id', user.id).eq('provider', provider).eq('key_name', keyName);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, removed: true });
  }

  let encrypted: string;
  try { encrypted = encryptApiKey(apiKey); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Encryption is unavailable.' }, { status: 500 }); }
  const { error } = await supabase.from('user_api_keys').upsert({ user_id: user.id, provider, key_name: keyName, api_key: encrypted }, { onConflict: 'user_id,provider,key_name' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
