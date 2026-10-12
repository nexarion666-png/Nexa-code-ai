import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { commitFiles, getGitHubToken, githubRequest } from '@/lib/github';

export const maxDuration = 60;

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
  let repoCreated = false;
  try {
    const repo = await githubRequest<{ full_name: string; html_url: string; default_branch: string }>(saved.token, '/user/repos', { method: 'POST', body: JSON.stringify({ name: repoName, private: isPrivate, auto_init: true }) });
    repoCreated = true;
    // Save the link first so a later failure never leaves a repo that Nexa doesn't know about.
    const { error: updateError } = await supabase.from('projects').update({ github_repo_url: repo.html_url, github_repo_name: repo.full_name }).eq('id', projectId).eq('user_id', user.id);
    if (updateError) throw new Error(updateError.message);
    const { data: files, error: filesError } = await supabase.from('project_files').select('path,content').eq('project_id', projectId).order('path');
    if (filesError) throw new Error(filesError.message);
    if (files?.length) await commitFiles(saved.token, repo.full_name, repo.default_branch || 'main', files, 'Initial commit from Nexa');
    return NextResponse.json({ ok: true, url: repo.html_url, name: repo.full_name });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Could not create GitHub repository.';
    return NextResponse.json({ error: repoCreated ? `Repository was created, but uploading files failed: ${detail}. Open Tools and use Push to retry.` : detail, repoCreated }, { status: 400 });
  }
}
