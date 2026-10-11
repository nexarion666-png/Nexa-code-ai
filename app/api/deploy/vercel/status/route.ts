import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decryptApiKey } from '@/lib/ai/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type VercelDeployment = {
  id?: string;
  url?: string;
  readyState?: 'QUEUED' | 'BUILDING' | 'INITIALIZING' | 'READY' | 'ERROR' | 'CANCELED';
  errorCode?: string;
  errorMessage?: string;
  error?: { code?: string; message?: string };
};

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const projectId = (url.searchParams.get('projectId') ?? '').trim();
  if (!projectId) return NextResponse.json({ error: 'projectId is required.' }, { status: 400 });

  const { data: project } = await supabase
    .from('projects').select('id').eq('id', projectId).eq('user_id', user.id).maybeSingle();
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const { data: deployment, error: deploymentError } = await supabase
    .from('deployments')
    .select('id,url,status,vercel_deployment_id,created_at')
    .eq('project_id', projectId).eq('user_id', user.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (deploymentError) return NextResponse.json({ error: deploymentError.message }, { status: 500 });
  if (!deployment) return NextResponse.json({ status: 'NOT_DEPLOYED', deployment: null });

  // Old rows without a Vercel ID cannot be verified. Never label them READY by assumption.
  if (!deployment.vercel_deployment_id) {
    return NextResponse.json({
      status: deployment.status === 'READY' ? 'UNKNOWN' : deployment.status,
      verified: false,
      deployment,
      message: 'This deployment has no Vercel deployment ID, so its build status cannot be verified.',
    });
  }

  const { data: credentials } = await supabase
    .from('user_github_tokens').select('vercel_token').eq('user_id', user.id).maybeSingle();
  if (!credentials?.vercel_token) return NextResponse.json({ error: 'Connect a Vercel token to check build status.' }, { status: 400 });

  let token: string;
  try { token = decryptApiKey(credentials.vercel_token); }
  catch { return NextResponse.json({ error: 'Saved Vercel token is invalid. Reconnect it in settings.' }, { status: 400 }); }

  const response = await fetch(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(deployment.vercel_deployment_id)}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  const raw = await response.text();
  let result: VercelDeployment = {};
  try { result = raw ? JSON.parse(raw) as VercelDeployment : {}; }
  catch { return NextResponse.json({ error: 'Vercel returned an unreadable deployment status.' }, { status: 502 }); }
  if (!response.ok) {
    return NextResponse.json({ error: result.error?.message ?? result.errorMessage ?? `Vercel status check failed (${response.status}).` }, { status: 502 });
  }

  const state = result.readyState ?? 'UNKNOWN';
  const message = result.error?.message ?? result.errorMessage ?? null;
  await supabase.from('deployments').update({ status: state }).eq('id', deployment.id).eq('user_id', user.id);

  return NextResponse.json({
    status: state,
    verified: state === 'READY',
    url: result.url ? (result.url.startsWith('http') ? result.url : `https://${result.url}`) : deployment.url,
    errorCode: result.error?.code ?? result.errorCode ?? null,
    error: state === 'ERROR' ? (message ?? 'Vercel build failed. Open the deployment logs for the compiler output.') : null,
    deployment: { ...deployment, status: state },
  });
}
