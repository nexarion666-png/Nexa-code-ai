import Link from 'next/link';
import { ArrowLeft, BarChart3, FolderCog } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getLimits, getPlan, getUsage } from '@/lib/limits';
import { ProjectSettingsClient } from '@/app/components/project-settings-client';

export default async function ProjectSettingsPage({ params }: { params: { id: string } }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { data: project } = await supabase.from('projects').select('id,name,is_public,created_at').eq('id', params.id).eq('user_id', user.id).single();
  if (!project) notFound();
  const usage = await getUsage(supabase, user.id);
  const plan = getPlan(user);
  const limits = getLimits(user);
  const { count: projectCount } = await supabase.from('projects').select('id', { count: 'exact', head: true }).eq('user_id', user.id);
  return <main className="nexa-shell min-h-svh px-3 pb-10 pt-4"><div className="mb-5 flex items-center gap-3"><Link href={`/app/${project.id}`} className="grid h-11 w-11 place-items-center rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-200"><ArrowLeft size={20}/></Link><div><h1 className="text-lg font-bold">Project settings</h1><p className="text-xs text-zinc-500">Manage {project.name}</p></div></div><ProjectSettingsClient project={project} plan={plan} usage={usage} limits={limits} projectCount={projectCount ?? 0}/></main>;
}
