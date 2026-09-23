'use client';

import { useState } from 'react';
import { ExternalLink, Github, Loader2, UploadCloud, Link2, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';

export function GitHubTools({ projectId, projectName, connected, repoUrl }: { projectId: string; projectName: string; connected: boolean; repoUrl: string | null }) {
  const [repoName, setRepoName] = useState(projectName.replace(/[^a-zA-Z0-9._-]+/g, '-'));
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [importUrl, setImportUrl] = useState('');

  async function createRepo() {
    setBusy(true); setMessage('Creating repository…');
    try {
      const res = await fetch('/api/github/create-repo', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ projectId, repoName, isPrivate }) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Could not create repository.');
      setMessage('Repository created.'); window.location.reload();
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Could not create repository.'); } finally { setBusy(false); }
  }

  async function push() {
    setBusy(true); setMessage('Pushing latest files…');
    try { const res = await fetch('/api/github/push', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId})}); const data=await res.json(); if(!res.ok) throw new Error(data.error||'Push failed.'); setMessage(`Pushed ${data.count} files.`); }
    catch(e){setMessage(e instanceof Error?e.message:'Push failed.');} finally{setBusy(false);}
  }

  async function importRepo() {
    setBusy(true); setMessage('Importing repository…');
    try { const res=await fetch('/api/github/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({githubUrl:importUrl})}); const data=await res.json(); if(!res.ok) throw new Error(data.error||'Import failed.'); window.location.href=`/app/${data.projectId}`; }
    catch(e){setMessage(e instanceof Error?e.message:'Import failed.');} finally{setBusy(false);}
  }

  if (!connected) return <div className="space-y-3"><Link href="/app/settings" className="flex items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-4 hover:border-violet-500/30"><div className="grid h-11 w-11 place-items-center rounded-xl bg-zinc-900 text-white"><Github size={21}/></div><div className="min-w-0 flex-1"><div className="font-medium">GitHub</div><div className="mt-1 text-xs text-zinc-500">Connect GitHub to create, push, or import repositories.</div></div><span className="text-xs text-violet-300">Connect</span></Link><ImportCard importUrl={importUrl} setImportUrl={setImportUrl} importRepo={importRepo} busy={busy}/></div>;

  return <div className="space-y-3"><div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-4"><div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-zinc-900 text-white"><Github size={21}/></div><div className="flex-1"><div className="font-medium">GitHub</div><div className="mt-1 flex items-center gap-1 text-xs text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>Connected</div></div></div>{repoUrl ? <div className="mt-4"><a href={repoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-[#09090b] px-3 py-3 text-xs text-zinc-300"><Link2 size={14} className="text-violet-300"/><span className="min-w-0 flex-1 truncate">{repoUrl}</span><ExternalLink size={14}/></a><button onClick={push} disabled={busy} className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 text-sm font-semibold disabled:opacity-50">{busy?<Loader2 size={16} className="animate-spin"/>:<UploadCloud size={16}/>}Push Latest Changes</button></div> : <><div className="mt-4"><label className="text-xs text-zinc-500">Repository name<input value={repoName} onChange={e=>setRepoName(e.target.value)} className="mt-2 h-11 w-full rounded-xl border border-zinc-800 bg-[#09090b] px-3 text-sm outline-none focus:border-violet-500"/></label></div><label className="mt-3 flex items-center justify-between rounded-xl border border-zinc-800 bg-[#09090b] px-3 py-3 text-xs text-zinc-300"><span>Make Private</span><button type="button" onClick={()=>setIsPrivate(v=>!v)} className={`relative h-6 w-11 rounded-full ${isPrivate?'bg-violet-600':'bg-zinc-800'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white ${isPrivate?'left-6':'left-1'}`}/></button></label><button onClick={createRepo} disabled={busy || !repoName.trim()} className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 text-sm font-semibold disabled:opacity-50">{busy?<Loader2 size={16} className="animate-spin"/>:<Github size={16}/>}Create Repo</button></>}</div><ImportCard importUrl={importUrl} setImportUrl={setImportUrl} importRepo={importRepo} busy={busy}/>{message&&<div className="rounded-xl border border-zinc-800 px-3 py-2 text-xs text-zinc-400">{message}</div>}</div>;
}

function ImportCard({ importUrl, setImportUrl, importRepo, busy }: { importUrl: string; setImportUrl: (value:string)=>void; importRepo:()=>void; busy:boolean }) { return <div className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-4"><div className="flex items-center gap-2 text-sm font-medium"><UploadCloud size={17} className="text-indigo-300"/>Import repository</div><p className="mt-1 text-xs text-zinc-600">Import a GitHub repository into a new Nexa project.</p><input value={importUrl} onChange={e=>setImportUrl(e.target.value)} placeholder="https://github.com/user/repo" className="mt-3 h-11 w-full rounded-xl border border-zinc-800 bg-[#09090b] px-3 text-sm outline-none focus:border-violet-500"/><button onClick={importRepo} disabled={busy || !importUrl.trim()} className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 text-sm disabled:opacity-50">{busy?<Loader2 size={15} className="animate-spin"/>:<CheckCircle2 size={15}/>}Import</button></div>; }
