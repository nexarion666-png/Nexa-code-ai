import JSZip from 'jszip';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });
  const body = await request.json().catch(() => ({}));
  const projectId = String(body.projectId ?? '');
  if (!projectId) return new Response('projectId is required.', { status: 400 });

  const { data: project } = await supabase.from('projects').select('id,name').eq('id', projectId).eq('user_id', user.id).single();
  if (!project) return new Response('Project not found.', { status: 404 });
  const { data: files, error } = await supabase.from('project_files').select('path,content').eq('project_id', projectId).order('path');
  if (error) return new Response(error.message, { status: 500 });

  const zip = new JSZip();
  for (const file of files ?? []) zip.file(file.path, file.content ?? '');
  if (!(files ?? []).some(file => file.path === 'README.md')) zip.file('README.md', 'Built with Nexa\n');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const safeName = String(project.name).replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'nexa-project';
  return new Response(blob, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
}
