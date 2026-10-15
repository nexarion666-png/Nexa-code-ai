import Link from 'next/link';
import { ArrowLeft, ExternalLink, FileCode2, FolderOpen, Lock, Sparkles } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { PreviewFrame } from '@/components/PreviewFrame';

export default async function ShareProjectPage({ params }: { params: { projectId: string } }) {
  const supabase = await createClient();
  const { data: project } = await supabase.from('projects').select('id,name,is_public,created_at').eq('id', params.projectId).eq('is_public', true).maybeSingle();
  if (!project) {
    return <main className="nexa-shell min-h-svh grid place-items-center px-5"><div className="w-full max-w-md rounded-3xl border border-zinc-800 bg-[#101010] p-7 text-center"><Lock className="mx-auto text-zinc-600" size={32}/><h1 className="mt-4 text-xl font-bold">Project not available</h1><p className="mt-2 text-sm leading-6 text-zinc-500">This project is private or the share link is no longer active.</p><Link href="/" className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-violet-600 px-5 text-sm font-semibold">Go to Nexa Code</Link></div></main>;
  }
  const { data: files } = await supabase.from('project_files').select('id,path,content,updated_at').eq('project_id', project.id).order('path');

  return <main className="min-h-svh bg-[#0e0e0e] text-zinc-100">
    <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-[#0e0e0e]/90 px-4 py-3 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center gap-3"><Link href="/" className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-800 text-zinc-400"><ArrowLeft size={18}/></Link><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Sparkles size={16} className="text-violet-400"/><h1 className="truncate font-semibold">{project.name}</h1></div><p className="text-[11px] text-zinc-600">Public Nexa Code project</p></div><span className="hidden rounded-full border border-emerald-500/20 bg-emerald-500/5 px-3 py-1 text-[11px] text-emerald-300 sm:block">View only</span><a href={`/api/preview/${project.id}`} target="_blank" rel="noreferrer" className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-800 text-zinc-400" title="Open preview"><ExternalLink size={17}/></a></div>
    </header>
    <div className="mx-auto grid max-w-6xl gap-4 px-4 py-5 lg:grid-cols-[280px_1fr]">
      <aside className="rounded-3xl border border-zinc-800 bg-[#111111] p-3"><div className="mb-3 flex items-center gap-2 px-2 text-xs font-semibold text-zinc-300"><FolderOpen size={16} className="text-violet-400"/>Files <span className="ml-auto text-zinc-600">{files?.length ?? 0}</span></div><div className="space-y-1">{(files ?? []).map(file => <div key={file.id} className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-xs text-zinc-500"><FileCode2 size={14}/><span className="truncate">{file.path}</span></div>)}{!files?.length && <p className="px-2 py-8 text-center text-xs text-zinc-600">No files yet.</p>}</div></aside>
      <section><div className="mb-3"><div className="text-xs uppercase tracking-[0.18em] text-zinc-600">Live preview</div><h2 className="mt-1 text-xl font-semibold">{project.name}</h2></div><PreviewFrame projectId={project.id}/></section>
    </div>
  </main>;
}
