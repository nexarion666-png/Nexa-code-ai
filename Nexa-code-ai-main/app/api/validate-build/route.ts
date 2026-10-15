import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { validateProjectPreflight } from '@/lib/build-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const projectId = String(body.projectId ?? '').trim();
  if (!projectId) return NextResponse.json({ error: 'projectId is required.' }, { status: 400 });

  const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', user.id).maybeSingle();
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const { data: files, error } = await supabase.from('project_files').select('path,content').eq('project_id', projectId).order('path');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  try {
    const result = validateProjectPreflight((files ?? []).map(file => ({ path: file.path, content: file.content ?? '' })));
    return NextResponse.json({ ...result, verified: false, stage: 'static-preflight', message: 'Static checks passed. Vercel production build verification is still required.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Build preflight failed.';
    return NextResponse.json({ ok: false, verified: false, stage: 'static-preflight', code: 'BUILD_PREFLIGHT_FAILED', error: message }, { status: 422 });
  }
}
