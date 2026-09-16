import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/auth';
import { guardRequest } from '@/lib/security';
import { randomBytes } from 'crypto';
export async function GET(req: Request) {
  try {
    const { supabase } = await requireUser();
    const clientId = process.env.GITHUB_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID;
    if (!clientId) return NextResponse.json({ error: 'GitHub OAuth is not configured.' }, { status: 503 });
    const url = new URL(req.url), state = randomBytes(24).toString('hex');
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) throw new Error('Authentication required.');
    const callback = `${url.origin}/api/github/callback`;
    const auth = new URL('https://github.com/login/oauth/authorize');
    auth.searchParams.set('client_id', clientId); auth.searchParams.set('redirect_uri', callback); auth.searchParams.set('scope', 'repo read:user'); auth.searchParams.set('state', state);
    const response = NextResponse.redirect(auth);
    response.cookies.set('nexa_github_oauth_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 600, path: '/' });
    return response;
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not start GitHub connection.' }, { status: 401 }); }
}
