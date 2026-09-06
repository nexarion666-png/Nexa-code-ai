import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/auth';
import { encryptSecret } from '@/lib/crypto';
export async function GET(req: Request) {
  const url = new URL(req.url), code = url.searchParams.get('code'), state = url.searchParams.get('state');
  const response = NextResponse.redirect(new URL('/?github=connected', url.origin));
  const expected = (await (async()=>{ try { return (await import('next/headers')).cookies(); } catch { return null; } })());
  const cookieState = expected?.get('nexa_github_oauth_state')?.value;
  if (!code || !state || !cookieState || state !== cookieState) return NextResponse.redirect(new URL('/?github=error', url.origin));
  const clientId = process.env.GITHUB_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID, clientSecret = process.env.GITHUB_CLIENT_SECRET || process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return NextResponse.redirect(new URL('/?github=config', url.origin));
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }) });
    const tokenData = await tokenRes.json(); if (!tokenRes.ok || !tokenData.access_token) throw new Error(tokenData.error_description || 'GitHub OAuth token exchange failed.');
    const userResponse = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!userResponse.ok) throw new Error('GitHub user lookup failed.');
    const userInfo = await userResponse.json();
    const { supabase, user } = await requireUser();
    const encrypted = await encryptSecret(tokenData.access_token);
    await supabase.from('github_connections').upsert({ owner_id: user.id, github_user_id: String(userInfo.id), login: userInfo.login, encrypted_token: encrypted, scopes: tokenData.scope || 'repo read:user', updated_at: new Date().toISOString() }, { onConflict: 'owner_id' });
    response.cookies.delete('nexa_github_oauth_state'); return response;
  } catch { return NextResponse.redirect(new URL('/?github=error', url.origin)); }
}
