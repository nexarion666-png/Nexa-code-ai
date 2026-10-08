import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ensureCompleteNextProject, type ProjectFile } from '@/lib/project-completeness';

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

  // Validate the complete post-apply project BEFORE writing anything to Supabase.
  // This prevents a proposal from becoming an applied project when a generated file
  // imports a missing local module such as @/components/SearchModal.
  const { data: currentFiles, error: currentFilesError } = await supabase
    .from('project_files')
    .select('path,content')
    .eq('project_id', proposal.project_id);
  if (currentFilesError) return NextResponse.json({ error: currentFilesError.message }, { status: 500 });

  const candidate = new Map<string, ProjectFile>();
  for (const file of currentFiles ?? []) candidate.set(file.path, { path: file.path, content: file.content ?? '' });
  for (const change of changes ?? []) {
    if (change.operation === 'delete') candidate.delete(change.path);
    else candidate.set(change.path, { path: change.path, content: change.new_content ?? '' });
  }

  let validatedFiles: ProjectFile[];
  try {
    validatedFiles = ensureCompleteNextProject(Array.from(candidate.values()));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Generated project failed validation.';
    console.error('[NEXA APPLY VALIDATION FAILED]', message);
    return NextResponse.json({
      error: 'PROPOSAL_VALIDATION_FAILED',
      message: `Proposal was not applied. ${message}`,
    }, { status: 422 });
  }

  // A validator may repair a known package dependency. Include that repair in the
  // same transaction-like apply sequence so the saved project matches validation.
  const validatedByPath = new Map(validatedFiles.map(file => [file.path, file.content]));
  const changesToApply = [...(changes ?? [])];
  for (const file of validatedFiles) {
    const original = candidate.get(file.path)?.content;
    if (original !== file.content) {
      const existing = (currentFiles ?? []).some(current => current.path === file.path);
      const index = changesToApply.findIndex(change => change.path === file.path && change.operation !== 'delete');
      if (index >= 0) changesToApply[index] = { ...changesToApply[index], new_content: file.content };
      else changesToApply.push({ path: file.path, operation: existing ? 'update' : 'create', new_content: file.content });
    }
  }

  for (const change of changesToApply) {
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
  return NextResponse.json({ success: true, changesCount: changesToApply.length });
}
