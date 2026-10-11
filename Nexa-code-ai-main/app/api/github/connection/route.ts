import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getGitHubToken, githubRequest } from '@/lib/github';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const saved = await getGitHubToken(supabase, user.id);
    if (!saved) return NextResponse.json({ connected: false });
    const profile = await githubRequest<{ login: string; html_url: string }>(saved.token, '/user');
    if (profile.login !== saved.username) await supabase.from('user_github_tokens').update({ username: profile.login }).eq('user_id', user.id);
    return NextResponse.json({ connected: true, username: profile.login, url: profile.html_url });
  } catch (error) {
    return NextResponse.json({ connected: false, error: error instanceof Error ? error.message : 'GitHub connection failed.' }, { status: 400 });
  }
}
