import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/auth';
import { encryptSecret } from '@/lib/crypto';
import { guardRequest } from '@/lib/security';

const providers = new Set(['google-ai-studio', 'groq', 'openrouter', 'huggingface']);

export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase.from('provider_keys').select('id, provider, label, enabled, priority, created_at').eq('owner_id', user.id).order('priority').order('created_at');
    if (error) throw error;
    return NextResponse.json({ keys: data ?? [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load provider keys.' }, { status: 401 });
  }
}

export async function POST(req: Request) {
  try {
    const guard = await guardRequest(req, 'provider-key-write', 10); if (guard instanceof NextResponse) return guard;
    const { supabase, user } = guard as any;
    const body = await req.json();
    const provider = typeof body.provider === 'string' ? body.provider : '';
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : null;
    const priority = Number.isFinite(body.priority) ? Number(body.priority) : 100;
    if (!providers.has(provider)) return NextResponse.json({ error: 'Unsupported provider.' }, { status: 400 });
    if (!key) return NextResponse.json({ error: 'API key is required.' }, { status: 400 });
    const encrypted_key = await encryptSecret(key);
    const { data, error } = await supabase.from('provider_keys').insert({ owner_id: user.id, provider, encrypted_key, label, priority, enabled: true }).select('id, provider, label, enabled, priority, created_at').single();
    if (error) throw error;
    return NextResponse.json({ key: data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not save provider key.' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const guard = await guardRequest(req, 'provider-key-write', 20); if (guard instanceof NextResponse) return guard;
    const { supabase, user } = guard as any;
    const body = await req.json();
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) return NextResponse.json({ error: 'Key id is required.' }, { status: 400 });
    const patch: Record<string, unknown> = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (Number.isFinite(body.priority)) patch.priority = Number(body.priority);
    if (typeof body.label === 'string') patch.label = body.label.trim().slice(0, 80);
    const { data, error } = await supabase.from('provider_keys').update(patch).eq('id', id).eq('owner_id', user.id).select('id, provider, label, enabled, priority, created_at').single();
    if (error) throw error;
    return NextResponse.json({ key: data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not update provider key.' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const guard = await guardRequest(req, 'provider-key-write', 20); if (guard instanceof NextResponse) return guard;
    const { supabase, user } = guard as any;
    const body = await req.json();
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) return NextResponse.json({ error: 'Key id is required.' }, { status: 400 });
    const { error } = await supabase.from('provider_keys').delete().eq('id', id).eq('owner_id', user.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not delete provider key.' }, { status: 500 });
  }
}
