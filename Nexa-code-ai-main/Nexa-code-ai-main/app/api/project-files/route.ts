import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const projectId = new URL(request.url).searchParams.get('projectId') ?? '';
  if (!projectId) return NextResponse.json({ error: 'projectId is required.' }, { status: 400 });

  const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', user.id).single();
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const [{ data: files, error: filesError }, { data: proposals, error: proposalError }] = await Promise.all([
    supabase.from('project_files').select('id,path,content,updated_at').eq('project_id', projectId).order('path'),
    supabase.from('proposals').select('id,status,created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1),
  ]);
  if (filesError || proposalError) return NextResponse.json({ error: filesError?.message ?? proposalError?.message }, { status: 500 });

  const latestProposal = proposals?.[0] ?? null;
  let changes: { id: string; path: string; operation: 'create' | 'update' | 'delete'; old_content: string | null; new_content: string | null }[] = [];
  if (latestProposal?.status === 'pending') {
    const { data, error } = await supabase.from('file_changes').select('id,path,operation,old_content,new_content').eq('proposal_id', latestProposal.id).order('path');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    changes = data ?? [];
  }
  return NextResponse.json({ files: files ?? [], latestProposal, changes });
}
