import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { commitFiles, getGitHubToken, githubRequest, parseGithubUrl } from '@/lib/github';

export const maxDuration = 60;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const projectId = String(body.projectId ?? '');
  if (!projectId) return NextResponse.json({ error: 'projectId is required.' }, { status: 400 });
  const { data: project, error: projectError } = await supabase.from('projects').select('id,github_repo_url').eq('id', projectId).eq('user_id', user.id).single();
  if (projectError || !project || !project.github_repo_url) return NextResponse.json({ error: 'No GitHub repository is connected.' }, { status: 404 });
  const saved = await getGitHubToken(supabase, user.id);
  if (!saved) return NextResponse.json({ error: 'Connect GitHub in Settings first.' }, { status: 400 });
  const { owner, repo } = parseGithubUrl(project.github_repo_url);
  const { data: files, error: filesError } = await supabase.from('project_files').select('path,content').eq('project_id', projectId).order('path');
  if (filesError) return NextResponse.json({ error: filesError.message }, { status: 500 });
  try {
    if (files?.length) {
      const info = await githubRequest<{ default_branch: string }>(saved.token, `/repos/${owner}/${repo}`);
      await commitFiles(saved.token, `${owner}/${repo}`, info.default_branch || 'main', files, 'Update from Nexa');
    }
    return NextResponse.json({ ok: true, count: files?.length ?? 0, url: project.github_repo_url });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not push project files.' }, { status: 400 });
  }
}
