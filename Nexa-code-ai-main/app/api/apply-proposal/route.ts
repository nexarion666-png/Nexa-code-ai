import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const proposalId = String(body.proposalId ?? '');
  if (!proposalId) return NextResponse.json({ error: 'proposalId is required.' }, { status: 400 });

  const { data: proposal } = await supabase.from('proposals').select('id,project_id,status').eq('id', proposalId).eq('user_id', user.id).single();
  if (!proposal) return NextResponse.json({ error: 'Proposal not found.' }, { status: 404 });
  if (proposal.status === 'applied') return NextResponse.json({ success: true, alreadyApplied: true });

  const { data: changes, error: changesError } = await supabase.from('file_changes').select('path,operation,new_content').eq('proposal_id', proposalId).order('path');
  if (changesError) return NextResponse.json({ error: changesError.message }, { status: 500 });

  for (const change of changes ?? []) {
    if (change.operation === 'delete') {
      const { error } = await supabase.from('project_files').delete().eq('project_id', proposal.project_id).eq('path', change.path);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      continue;
    }
    const { error } = await supabase.from('project_files').upsert({
      project_id: proposal.project_id,
      path: change.path,
      content: change.new_content ?? '',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id,path' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error: statusError } = await supabase.from('proposals').update({ status: 'applied' }).eq('id', proposalId).eq('user_id', user.id);
  if (statusError) return NextResponse.json({ error: statusError.message }, { status: 500 });
  return NextResponse.json({ success: true, changesCount: changes?.length ?? 0 });
}
