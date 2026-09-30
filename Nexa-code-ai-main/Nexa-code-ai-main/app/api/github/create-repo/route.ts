import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encodeContent, getGitHubToken, githubRequest } from '@/lib/github';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const projectId = String(body.projectId ?? '');
  const repoNameInput = String(body.repoName ?? '').trim();
  const isPrivate = Boolean(body.isPrivate);
  if (!projectId) return NextResponse.json({ error: 'projectId is required.' }, { status: 400 });
  const { data: project, error: projectError } = await supabase.from('projects').select('id,name,github_repo_url').eq('id', projectId).eq('user_id', user.id).single();
  if (projectError || !project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  if (project.github_repo_url) return NextResponse.json({ error: 'This project is already connected to GitHub.', url: project.github_repo_url }, { status: 409 });
  const saved = await getGitHubToken(supabase, user.id);
  if (!saved) return NextResponse.json({ error: 'Connect GitHub in Settings first.' }, { status: 400 });
  const repoName = (repoNameInput || project.name || 'nexa-project').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'nexa-project';
  try {
    const repo = await githubRequest<{ full_name: string; html_url: string }>(saved.token, '/user/repos', { method: 'POST', body: JSON.stringify({ name: repoName, private: isPrivate, auto_init: false }) });
    const { data: files, error: filesError } = await supabase.from('project_files').select('path,content').eq('project_id', projectId).order('path');
    if (filesError) throw new Error(filesError.message);
    for (const file of files ?? []) {
      await githubRequest(saved.token, `/repos/${repo.full_name}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body: JSON.stringify({ message: 'Initial commit from Nexa', content: encodeContent(file.content ?? '') }) });
    }
    const { error: updateError } = await supabase.from('projects').update({ github_repo_url: repo.html_url, github_repo_name: repo.full_name }).eq('id', projectId).eq('user_id', user.id);
    if (updateError) throw new Error(updateError.message);
    return NextResponse.json({ ok: true, url: repo.html_url, name: repo.full_name });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create GitHub repository.' }, { status: 400 });
  }
}
