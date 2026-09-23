import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { ProjectsClient } from '@/app/components/projects-client';

export default async function ProjectsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: projects } = await supabase.from('projects').select('id,name,created_at,github_repo_url,github_repo_name').order('created_at', { ascending: false });
  return <ProjectsClient projects={projects ?? []} />;
}
