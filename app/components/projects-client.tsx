'use client';
import { useState } from 'react';
import { Folder, Plus, ArrowRight, Github } from 'lucide-react';
import Link from 'next/link';
import { ProjectModal } from './project-modal';

type Project = { id: string; name: string; created_at: string; github_repo_url?: string | null; github_repo_name?: string | null };
export function ProjectsClient({ projects }: { projects: Project[] }) {
  const [open,setOpen]=useState(false);
  return <main className="nexa-shell min-h-svh px-4 py-6"><div className="flex items-center justify-between"><div><div className="text-xl font-black"><span>NEXA</span> <span className="text-violet-500">CODE</span></div><div className="text-xs text-zinc-500">Your projects</div></div><button onClick={()=>setOpen(true)} className="grid h-11 w-11 place-items-center rounded-xl bg-violet-600 shadow-[0_0_22px_rgba(139,92,246,.35)]"><Plus size={21}/></button></div><div className="mt-7 rounded-3xl border border-zinc-800 bg-[#10131f] p-4"><div className="mb-3 text-sm font-semibold text-zinc-200">Projects</div>{projects.length===0 ? <div className="py-10 text-center"><Folder className="mx-auto text-zinc-700" size={40}/><p className="mt-3 text-sm text-zinc-500">No projects yet.</p><button onClick={()=>setOpen(true)} className="mt-4 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold">Create project</button></div> : <div className="space-y-2">{projects.map(p=><Link href={`/app/${p.id}`} key={p.id} className="flex items-center gap-3 rounded-2xl border border-zinc-800 p-3 hover:bg-zinc-900"><Folder className="text-indigo-400" size={20}/><span className="flex-1 text-sm">{p.name}</span>{p.github_repo_url && <Github size={15} className="text-zinc-400"/>}<ArrowRight size={17} className="text-zinc-600"/></Link>)}</div>}</div><ProjectModal open={open} onClose={()=>setOpen(false)}/></main>;
}
