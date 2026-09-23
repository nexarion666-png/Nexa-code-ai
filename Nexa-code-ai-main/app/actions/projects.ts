'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getLimits, getPlan, getProjectCount } from '@/lib/limits';

export async function createProject(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) throw new Error('Project name is required.');

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const projectCount = await getProjectCount(supabase, user.id);
  const limits = getLimits(user);
  if (getPlan(user) === 'FREE' && projectCount >= limits.projects) {
    throw new Error(`Free plan allows ${limits.projects} projects. Upgrade to Pro for unlimited projects.`);
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({ name, user_id: user.id })
    .select('id')
    .single();

  if (error) throw new Error(error.message);
  revalidatePath('/app');
  redirect(`/app/${data.id}`);
}


export async function updateProject(projectId: string, name: string) {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Project name is required.');
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { error } = await supabase.from('projects').update({ name: cleanName }).eq('id', projectId).eq('user_id', user.id);
  if (error) throw new Error(error.message);
  revalidatePath(`/app/${projectId}`);
  revalidatePath(`/project/${projectId}/settings`);
}

export async function setProjectPublic(projectId: string, isPublic: boolean) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const { error } = await supabase.from('projects').update({ is_public: isPublic }).eq('id', projectId).eq('user_id', user.id);
  if (error) throw new Error(error.message);
  revalidatePath(`/app/${projectId}`);
  revalidatePath(`/project/${projectId}/settings`);
  revalidatePath(`/share/${projectId}`);
}

export async function deleteProject(projectId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId)
    .eq('user_id', user.id);

  if (error) throw new Error(error.message);
  revalidatePath('/app');
  redirect('/app');
}
