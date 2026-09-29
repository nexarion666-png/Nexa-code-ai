import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: { projectId: string } }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: project } = await supabase.from('projects').select('id,is_public').eq('id', params.projectId).eq('user_id', user.id).single();
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const isPublic = !project.is_public;
  const { error } = await supabase.from('projects').update({ is_public: isPublic }).eq('id', project.id).eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const origin = new URL(_request.url).origin;
  return NextResponse.json({ isPublic, url: `${origin}/share/${project.id}` });
}
