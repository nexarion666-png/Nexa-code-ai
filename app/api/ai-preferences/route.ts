import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { normalizeProviderOrder } from '@/lib/ai/user-keys';

export const runtime = 'nodejs';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await supabase.from('user_ai_preferences').select('provider_order').eq('user_id', user.id).maybeSingle();
  if (error) return NextResponse.json({ error: 'Could not load AI preferences. Apply the AI preferences migration first.' }, { status: 500 });
  return NextResponse.json({ providerOrder: normalizeProviderOrder(data?.provider_order) });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.providerOrder) || body.providerOrder.length !== 4 || new Set(body.providerOrder).size !== 4) {
    return NextResponse.json({ error: 'Choose each provider exactly once.' }, { status: 400 });
  }
  const order = normalizeProviderOrder(body.providerOrder);
  if (order.length !== 4 || order.some((provider, index) => provider !== body.providerOrder[index])) {
    return NextResponse.json({ error: 'Invalid provider order.' }, { status: 400 });
  }
  const { error } = await supabase.from('user_ai_preferences').upsert({ user_id: user.id, provider_order: order, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, providerOrder: order });
}
