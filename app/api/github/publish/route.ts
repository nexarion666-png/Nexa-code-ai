import { NextResponse } from 'next/server';
import { decryptSecret } from '@/lib/crypto';
import { publishRepositoryFiles } from '@/lib/github';
import { guardRequest, validateRelativePath } from '@/lib/security';

export async function POST(req: Request) {
  try {
    const { supabase, user } = await guardRequest(
      req,
      'github-publish',
      5
    ) as any;

    const body = await req.json();

    const projectId = String(body.projectId || '').trim();
    const repo = String(body.repo || '').trim();
    const branch = String(body.branch || 'main').trim() || 'main';
    const message = String(
      body.message || 'Update from Nexa Code AI'
    ).slice(0, 200);

    if (!projectId || !repo) {
      return NextResponse.json(
        { error: 'Project and repository are required.' },
        { status: 400 }
      );
    }

    /*
     * Verify the project belongs to the authenticated user
     * before accessing or publishing any project files.
     */
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('owner_id', user.id)
      .single();

    if (projectError || !project) {
      return NextResponse.json(
        { error: 'Project not found.' },
        { status: 404 }
      );
    }

    const { data: conn, error: connectionError } = await supabase
      .from('github_connections')
      .select('encrypted_token')
      .eq('owner_id', user.id)
      .single();

    if (connectionError || !conn) {
      return NextResponse.json(
        { error: 'Connect GitHub first.' },
        { status: 400 }
      );
    }

    const { data: files, error: filesError } = await supabase
      .from('project_files')
      .select('path,content')
      .eq('project_id', projectId);

    if (filesError) {
      throw filesError;
    }

    const safeFiles = (files ?? []).map((file: any) => ({
      path: validateRelativePath(file.path),
      content: String(file.content ?? ''),
    }));

    if (!safeFiles.length) {
      return NextResponse.json(
        { error: 'The project has no files to publish.' },
        { status: 400 }
      );
    }

    const parts = repo.split('/');

    if (
      parts.length !== 2 ||
      !parts[0] ||
      !parts[1]
    ) {
      return NextResponse.json(
        { error: 'Repository must be owner/name.' },
        { status: 400 }
      );
    }

    const token = await decryptSecret(conn.encrypted_token);

    const result = await publishRepositoryFiles({
      owner: parts[0],
      repo: parts[1],
      branch,
      files: safeFiles,
      message,
      token,
    });

    const { error: updateError } = await supabase
      .from('projects')
      .update({
        github_repo: repo,
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .eq('owner_id', user.id);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({ result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'GitHub publish failed.',
      },
      { status: 400 }
    );
  }
}
