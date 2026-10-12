import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptApiKey } from '@/lib/ai/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type VercelEvent = {
  type?: string;
  created?: string;
  payload?: { text?: string; info?: { name?: string; step?: string; type?: string; path?: string }; statusCode?: number };
};

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const projectId = (new URL(request.url).searchParams.get('projectId') ?? '').trim();
  if (!projectId) return NextResponse.json({ error: 'projectId is required.' }, { status: 400 });
  const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', user.id).maybeSingle();
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const { data: deployment, error: deploymentError } = await supabase
    .from('deployments').select('id,status,vercel_deployment_id').eq('project_id', projectId).eq('user_id', user.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (deploymentError) return NextResponse.json({ error: deploymentError.message }, { status: 500 });
  if (!deployment?.vercel_deployment_id) return NextResponse.json({ error: 'No verifiable Vercel deployment was found.' }, { status: 404 });

  const { data: credentials } = await supabase.from('user_github_tokens').select('vercel_token').eq('user_id', user.id).maybeSingle();
  if (!credentials?.vercel_token) return NextResponse.json({ error: 'Connect a Vercel token to view build logs.' }, { status: 400 });
  let token: string;
  try { token = decryptApiKey(credentials.vercel_token); }
  catch { return NextResponse.json({ error: 'Saved Vercel token is invalid. Reconnect it in settings.' }, { status: 400 }); }

  const eventsUrl = new URL(`https://api.vercel.com/v3/deployments/${encodeURIComponent(deployment.vercel_deployment_id)}/events`);
  eventsUrl.searchParams.set('limit', '100');
  eventsUrl.searchParams.set('direction', 'backward');
  const response = await fetch(eventsUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store' });
  const raw = await response.text();
  let events: VercelEvent[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) events = parsed as VercelEvent[];
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { events?: unknown }).events)) events = (parsed as { events: VercelEvent[] }).events;
  } catch {
    return NextResponse.json({ error: 'Vercel returned unreadable build logs.' }, { status: 502 });
  }
  if (!response.ok) return NextResponse.json({ error: `Vercel build log request failed (${response.status}).` }, { status: 502 });

  const logs = events.map(event => {
    const payload = event.payload;
    const text = typeof payload?.text === 'string' ? payload.text : '';
    const meta = [payload?.info?.step, payload?.info?.name, payload?.info?.path].filter(Boolean).join(' · ');
    return { type: event.type ?? 'log', created: event.created ?? null, text: text || meta };
  }).filter(event => event.text.trim()).slice(-100);
  return NextResponse.json({ status: deployment.status, deploymentId: deployment.vercel_deployment_id, logs });
}
