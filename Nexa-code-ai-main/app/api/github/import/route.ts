import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getLimits, getPlan, getProjectCount } from '@/lib/limits';
import { getGitHubToken, githubRequest, parseGithubUrl } from '@/lib/github';

type Repo = { full_name: string; name: string; default_branch: string; html_url: string };
type Tree = { tree: { path: string; type: string; sha: string; size?: number }[] };
type Blob = { encoding: string; content: string };

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const githubUrl = String(body.githubUrl ?? '').trim();
  if (!githubUrl) return NextResponse.json({ error: 'GitHub URL is required.' }, { status: 400 });
  const plan = getPlan(user); const limits = getLimits(user); const count = await getProjectCount(supabase, user.id);
  if (plan === 'FREE' && count >= limits.projects) return NextResponse.json({ error: `Free plan allows ${limits.projects} projects.` }, { status: 429 });
  const saved = await getGitHubToken(supabase, user.id);
  if (!saved) return NextResponse.json({ error: 'Connect GitHub in Settings first.' }, { status: 400 });
  try {
    const { owner, repo } = parseGithubUrl(githubUrl);
    const metadata = await githubRequest<Repo>(saved.token, `/repos/${owner}/${repo}`);
    const tree = await githubRequest<Tree>(saved.token, `/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`);
    const files = tree.tree.filter(item => item.type === 'blob' && (item.size ?? 0) <= 1024 * 1024 && !item.path.startsWith('.git/'));
    const { data: project, error: projectError } = await supabase.from('projects').insert({ name: metadata.name, user_id: user.id, github_repo_url: metadata.html_url, github_repo_name: metadata.full_name }).select('id').single();
    if (projectError || !project) throw new Error(projectError?.message ?? 'Could not create project.');
    for (const file of files) {
      const blob = await githubRequest<Blob>(saved.token, `/git/blobs/${file.sha}`);
      if (blob.encoding !== 'base64') continue;
      const content = Buffer.from(blob.content.replace(/\n/g, ''), 'base64').toString('utf8');
      await supabase.from('project_files').upsert({ project_id: project.id, path: file.path, content, updated_at: new Date().toISOString() }, { onConflict: 'project_id,path' });
    }
    return NextResponse.json({ ok: true, projectId: project.id, files: files.length, url: metadata.html_url });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not import repository.' }, { status: 400 });
  }
}
