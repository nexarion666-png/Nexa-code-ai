import { NextResponse } from 'next/server';

import { decryptSecret } from '@/lib/crypto';
import { createGitHubRepo, getGitHubUser } from '@/lib/github';
import { guardRequest } from '@/lib/security';

export async function POST(req: Request) {
  try {
    const { supabase, user } = await guardRequest(
      req,
      'github-create-repo',
      5
    ) as any;

    const body = await req.json();

    const name = String(body.name || '').trim();
    const description = String(body.description || '').trim().slice(0, 500);
    const isPrivate = body.private !== false;
    const projectId = String(body.projectId || '').trim();

    if (!name) {
      return NextResponse.json(
        { error: 'Repository name is required.' },
        { status: 400 }
      );
    }

    if (!projectId) {
      return NextResponse.json(
        { error: 'Project is required.' },
        { status: 400 }
      );
    }

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id,name,github_repo')
      .eq('id', projectId)
      .eq('owner_id', user.id)
      .single();

    if (projectError || !project) {
      return NextResponse.json(
        { error: 'Project not found.' },
        { status: 404 }
      );
    }

    const { data: connection, error: connectionError } = await supabase
      .from('github_connections')
      .select('encrypted_token')
      .eq('owner_id', user.id)
      .single();

    if (connectionError || !connection) {
      return NextResponse.json(
        { error: 'Connect GitHub first.' },
        { status: 400 }
      );
    }

    const token = await decryptSecret(connection.encrypted_token);
    const githubUser = await getGitHubUser(token);

    const repository = await createGitHubRepo({
      name,
      description,
      private: isPrivate,
      token,
    });

    const owner = String(repository.owner?.login || githubUser.login || '');

    if (!owner) {
      throw new Error('GitHub did not return the repository owner.');
    }

    const fullName = String(
      repository.full_name || `${owner}/${repository.name}`
    );

    const { error: updateError } = await supabase
      .from('projects')
      .update({
        github_repo: fullName,
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .eq('owner_id', user.id);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({
      ok: true,
      repository: {
        id: repository.id,
        name: repository.name,
        full_name: fullName,
        private: repository.private,
        default_branch: repository.default_branch || 'main',
        html_url: repository.html_url,
      },
      projectId,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Could not create GitHub repository.',
      },
      { status: 400 }
    );
  }
}
