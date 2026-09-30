console.log('[NEXA ROUTE HIT] app/app/[projectId]/page.tsx');
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/app/components/app-shell';

export default async function ProjectPage({ params }: { params: { projectId: string } }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();
  const { data: project } = await supabase.from('projects').select('id,name,created_at,github_repo_url,github_repo_name').eq('id', params.projectId).single();
  if (!project) notFound();
  const { data: projects } = await supabase.from('projects').select('id,name,created_at,github_repo_url,github_repo_name').order('created_at', { ascending: false });
  const { data: messages } = await supabase.from('messages').select('id,role,content,created_at').eq('project_id', params.projectId).order('created_at', { ascending: true }).limit(100);
  const { data: latestProposal } = await supabase.from('proposals').select('id,status,created_at').eq('project_id', params.projectId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  let latestProposalChanges = 0;
  if (latestProposal) {
    const { count } = await supabase.from('file_changes').select('id', { count: 'exact', head: true }).eq('proposal_id', latestProposal.id);
    latestProposalChanges = count ?? 0;
  }
  const { data: githubConnection } = await supabase.from('user_github_tokens').select('username').eq('user_id', user.id).maybeSingle();
  return <AppShell project={project} projects={projects ?? []} initialMessages={(messages ?? []) as { id: string; role: 'user' | 'assistant'; content: string; created_at: string }[]} initialProposal={latestProposal ? { id: latestProposal.id, status: latestProposal.status, changesCount: latestProposalChanges } : null} githubConnected={Boolean(githubConnection?.username)} />;
}
