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

  const { data: changes, error: changesError } = await supabase.from('file_changes').select('path,operation,old_content,new_content').eq('proposal_id', proposalId).order('path');
  if (changesError) return NextResponse.json({ error: changesError.message }, { status: 500 });

  // Optimistic concurrency guard: never silently overwrite a file that changed
  // after this proposal was generated. Check every path before writing any path.
  const { data: currentFiles, error: currentFilesError } = await supabase
    .from('project_files')
    .select('path,content')
    .eq('project_id', proposal.project_id);
  if (currentFilesError) return NextResponse.json({ error: currentFilesError.message }, { status: 500 });
  const currentByPath = new Map((currentFiles ?? []).map(file => [file.path, file.content ?? '']));
  const conflicts = (changes ?? []).filter(change => {
    const exists = currentByPath.has(change.path);
    if (change.old_content === null) return exists; // create expected a missing file
    return !exists || currentByPath.get(change.path) !== (change.old_content ?? '');
  }).map(change => change.path);
  if (conflicts.length) {
    return NextResponse.json({
      error: 'This proposal is out of date because one or more files changed after it was generated. Review the latest project files and generate a new proposal before applying.',
      code: 'PROPOSAL_STALE',
      conflictingFiles: conflicts,
    }, { status: 409 });
  }

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
