import { NextResponse } from 'next/server';
import { guardRequest, readJson, validateRelativePath } from '@/lib/security';
import { requireUser } from '@/lib/supabase/auth';

export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const { supabase } = await requireUser();
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single();
    if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    const { data, error } = await supabase.from('project_files').select('path,content,version,updated_at').eq('project_id', projectId).order('path');
    if (error) throw error;
    return NextResponse.json({ files: data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not load files.' }, { status: 401 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const guard = await guardRequest(req, 'file-write', 60);
    if (guard instanceof NextResponse) return guard;
    const { supabase, user } = guard;
    const body = await readJson(req);
    const path = validateRelativePath(body.path);
    const content = typeof body.content === 'string' ? body.content : '';
    if (content.length > 1_000_000) return NextResponse.json({ error: 'File is too large.' }, { status: 413 });
    const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).eq('owner_id', user.id).single();
    if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    const { data: current } = await supabase.from('project_files').select('version').eq('project_id', projectId).eq('path', path).maybeSingle();
    const nextVersion = (current?.version ?? 0) + 1;
    const { data, error } = await supabase.from('project_files').upsert({ project_id: projectId, path, content, version: nextVersion, updated_at: new Date().toISOString() }, { onConflict: 'project_id,path' }).select('path,content,version,updated_at').single();
    if (error) throw error;
    await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId).eq('owner_id', user.id);
    return NextResponse.json({ file: data });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not save file.' }, { status: 400 });
  }
}
