import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { githubRequest, saveGitHubToken } from '@/lib/github';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const token = String(body.token ?? '').trim();
  if (!token) return NextResponse.json({ error: 'GitHub token is required.' }, { status: 400 });
  try {
    const profile = await githubRequest<{ login: string }>(token, '/user');
    await saveGitHubToken(supabase, user.id, token, profile.login);
    return NextResponse.json({ ok: true, username: profile.login });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'GitHub connection failed.' }, { status: 400 });
  }
}

export async function DELETE() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { error } = await supabase.from('user_github_tokens').delete().eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
