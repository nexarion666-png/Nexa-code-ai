'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Menu, RefreshCw, Download, ChevronDown, Folder, MessageSquare, Code2, Files, Zap, Check, Search, Plus, Home, Bookmark, CalendarDays, Trash2, Github, Cloud, Archive, X, Settings, Eye, Rocket, Share2 } from 'lucide-react';
import { deleteProject } from '@/app/actions/projects';
import { GitHubTools } from './github-tools';
import { ProjectModal } from './project-modal';
import { NexaMark } from './logo';
import { ChatPanel } from './chat-panel';
import { WorkspacePanel } from './workspace-panel';

type Project = { id: string; name: string; created_at: string; github_repo_url?: string | null; github_repo_name?: string | null };
type Tab = 'chat' | 'code' | 'files' | 'tools';
type WorkspaceTab = 'code' | 'preview';

const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'chat', label: 'Chat', icon: <MessageSquare size={22}/> },
  { key: 'code', label: 'Code', icon: <Code2 size={22}/> },
  { key: 'files', label: 'Files', icon: <Files size={22}/> },
  { key: 'tools', label: 'Tools', icon: <Zap size={22}/> }
];

export function AppShell({ project, projects, initialMessages, initialProposal, githubConnected = false }: { project: Project; projects: Project[]; initialMessages: { id: string; role: 'user' | 'assistant'; content: string; created_at: string }[]; initialProposal: { id: string; status: string; changesCount: number } | null; githubConnected?: boolean }) {
  const [tab, setTab] = useState<Tab>('chat');
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('code');
  const [projectOpen, setProjectOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [workspaceRefresh, setWorkspaceRefresh] = useState(0);
  const [autoReview, setAutoReview] = useState(0);
  const [shareToast, setShareToast] = useState('');
  const [aiStatus, setAiStatus] = useState<'primary' | 'fallback' | 'exhausted'>('primary');
  useEffect(() => {
    const onStatus = (event: Event) => {
      const status = (event as CustomEvent<'primary' | 'fallback' | 'exhausted'>).detail;
      if (status) setAiStatus(status);
    };
    window.addEventListener('nexa-ai-status', onStatus);
    return () => window.removeEventListener('nexa-ai-status', onStatus);
  }, []);

  function openWorkspace(view: WorkspaceTab) { setWorkspaceTab(view); setTab('code'); }
  function proposalGenerated() { setWorkspaceRefresh(value => value + 1); }
  function proposalApplied() { setWorkspaceRefresh(value => value + 1); }
  function reviewFromChat() { openWorkspace('code'); setAutoReview(value => value + 1); setWorkspaceRefresh(value => value + 1); }

  async function shareProject() {
    const link = `${window.location.origin}/share/${project.id}`;
    try { await fetch(`/api/share/${project.id}`, { method: 'POST' }); await navigator.clipboard?.writeText(link); setShareToast('Copied!'); window.setTimeout(() => setShareToast(''), 1800); } catch { setShareToast('Copy failed'); window.setTimeout(() => setShareToast(''), 1800); }
  }

  async function exportZip() {
    const response = await fetch('/api/download-zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id }) });
    if (!response.ok) return;
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${project.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'nexa-project'}.zip`; anchor.click(); URL.revokeObjectURL(url);
  }

  return <main className="nexa-shell min-h-svh pb-[78px]">
    <header className="sticky top-0 z-40 border-b border-zinc-900/90 bg-[#09090b]/95 px-3 pb-2 pt-3 backdrop-blur-xl">
      <div className="flex items-center gap-2">
        <button className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-zinc-800 bg-zinc-950/70 text-zinc-200"><Menu size={23}/></button>
        <div className="flex min-w-0 flex-1 items-center gap-2"><NexaMark small/><span title={aiStatus === 'exhausted' ? 'Gemini: 0/3 available | Groq: 0/1 | Cooldown: 60s left' : aiStatus === 'fallback' ? 'Gemini unavailable | Groq fallback active' : 'Gemini: primary active'} className={`h-2.5 w-2.5 rounded-full ${aiStatus === 'exhausted' ? 'bg-red-500 shadow-[0_0_10px_#ef4444]' : aiStatus === 'fallback' ? 'bg-yellow-400 shadow-[0_0_10px_#facc15]' : 'bg-emerald-400 shadow-[0_0_10px_#34d399]'}`} /><div className="min-w-0 leading-none"><div className="truncate text-[16px] font-black tracking-wide"><span className="text-white">NEXA</span> <span className="text-violet-500">CODE</span></div><div className="mt-1 truncate text-[10px] text-zinc-500">{project.name} · Build. Fix. Ship.</div></div></div>
        <div className="hidden md:flex items-center gap-1 rounded-full border border-zinc-800 bg-[#111113] p-1"><button onClick={() => openWorkspace('code')} className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs ${tab==='code' && workspaceTab==='code' ? 'bg-zinc-800 text-white' : 'text-zinc-500'}`}><Code2 size={14}/>Code</button><button onClick={() => openWorkspace('preview')} className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs ${tab==='code' && workspaceTab==='preview' ? 'bg-violet-600 text-white' : 'text-zinc-500'}`}><Eye size={14}/>Preview</button></div>
        <button title="Share project" onClick={shareProject} className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-800 text-zinc-300"><Share2 size={17}/></button>{shareToast && <div className="fixed right-3 top-20 z-[100] rounded-xl border border-emerald-500/30 bg-[#101812] px-3 py-2 text-xs text-emerald-300">{shareToast}</div>}<button title="Refresh" onClick={() => window.location.reload()} className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-800 text-zinc-300"><RefreshCw size={18}/></button>
        {project.github_repo_url && <a href={project.github_repo_url} target="_blank" rel="noreferrer" title="GitHub repository" className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-800 text-zinc-200"><Github size={17}/></a>}<Link href="/app/settings" title="AI Settings" className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-800 text-zinc-200"><Settings size={17}/></Link>
        <button title="Download ZIP" onClick={exportZip} className="hidden h-10 items-center gap-2 rounded-xl border border-zinc-700 bg-white px-3 text-xs font-semibold text-black sm:flex"><Download size={16}/>Download ZIP</button>
        <button title="Deploy" className="hidden h-10 items-center gap-2 rounded-xl border border-zinc-800 px-3 text-xs text-zinc-500 md:flex"><Rocket size={15}/>Deploy</button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 sm:hidden"><button title="Gemini: 2/3 available | Groq: 0/1 | Cooldown: 42s left" className="flex h-8 items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/5 px-3 text-[11px] text-emerald-300"><span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_#39ff88]"/>AI Ready<ChevronDown size={13}/></button><div className="flex items-center gap-1 rounded-full border border-zinc-800 bg-[#111113] p-1"><button onClick={() => openWorkspace('code')} className={`rounded-full px-3 py-1 text-[11px] ${tab==='code' && workspaceTab==='code' ? 'bg-zinc-800 text-white' : 'text-zinc-500'}`}>Code</button><button onClick={() => openWorkspace('preview')} className={`rounded-full px-3 py-1 text-[11px] ${tab==='code' && workspaceTab==='preview' ? 'bg-violet-600 text-white' : 'text-zinc-500'}`}>Preview</button></div></div>
    </header>

    <section className="px-3 pt-2"><div className="relative"><button onClick={()=>setProjectOpen(v=>!v)} className="glass flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left"><Folder className="shrink-0 text-indigo-400" size={27}/><span className="min-w-0 flex-1"><span className="block truncate text-base font-semibold text-zinc-100">{project.name}</span><span className="block text-xs text-indigo-300/80">Autonomous coding workspace</span></span><ChevronDown className={projectOpen ? 'rotate-180 text-indigo-300 transition' : 'text-indigo-300 transition'} size={21}/></button>{projectOpen && <div className="absolute left-0 right-0 top-[68px] z-50 overflow-hidden rounded-2xl border border-zinc-800 bg-[#111114] shadow-2xl"><div className="max-h-52 overflow-auto p-1">{projects.map(p=><Link key={p.id} href={`/app/${p.id}`} onClick={()=>setProjectOpen(false)} className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm ${p.id===project.id ? 'bg-violet-500/15 text-violet-200' : 'text-zinc-300 hover:bg-zinc-800'}`}><Folder size={18}/>{p.name}</Link>)}</div><div className="border-t border-zinc-800 p-2"><button onClick={()=>{setNewOpen(true);setProjectOpen(false)}} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-violet-300 hover:bg-violet-500/10"><Plus size={17}/>New project</button></div></div>}</div></section>

    <nav className="scrollbar-none flex gap-2 overflow-x-auto px-3 py-2">{tabs.map(t=><button key={t.key} onClick={()=>setTab(t.key)} className={`flex h-11 min-w-[86px] shrink-0 items-center justify-center gap-2 rounded-full text-sm font-medium transition ${tab===t.key ? 'bg-violet-600 text-white shadow-[0_0_25px_rgba(139,92,246,.42)]' : 'border border-transparent text-zinc-400 hover:bg-zinc-900'}`}>{t.icon}{t.label}</button>)}</nav>

    <section className="mx-3 mt-1 rounded-2xl border border-zinc-800 bg-[#0d101d] px-3 py-3"><div className="flex items-start justify-between gap-2"><div className="flex items-center gap-2"><NexaMark small/><div><div className="text-sm font-semibold text-indigo-100">NEXA AGENT</div><div className="mt-1 text-xs text-indigo-200/70">{tab === 'chat' ? 'Conversation mode · understanding first' : 'Workspace · review before applying'}</div></div></div></div><div className="mt-3 grid grid-cols-5 gap-0">{[['Understand','done',<Check size={15}/>], ['Plan','done',<Check size={15}/>], ['Build','active',<Code2 size={15}/>], ['Review','next',<Search size={15}/>], ['Improve','next',<RefreshCw size={15}/>]].map(([label,state,icon],i)=><div key={String(label)} className="relative text-center"><div className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full border ${state==='done' ? 'border-emerald-400 bg-emerald-400 text-black shadow-[0_0_16px_rgba(52,211,153,.4)]' : state==='active' ? 'border-violet-400 bg-violet-500/15 text-violet-200 shadow-[0_0_18px_rgba(139,92,246,.65)]' : 'border-zinc-700 bg-zinc-900 text-zinc-500'}`}>{icon}</div><div className={`mt-1.5 whitespace-nowrap text-[10px] ${state==='active'?'text-white':'text-zinc-400'}`}>{label}</div>{i<4 && <div className={`absolute left-[calc(50%+15px)] right-[calc(-50%+15px)] top-4 h-px ${state==='done' ? 'bg-emerald-400/60' : 'bg-zinc-800'}`}/>}</div>)}</div></section>

    <section className="px-3 pb-28 pt-3">
      {tab === 'chat' && <ChatPanel projectId={project.id} initialMessages={initialMessages} initialProposal={initialProposal} onProposalGenerated={proposalGenerated} onReviewChanges={reviewFromChat} />}
      {tab === 'code' && <WorkspacePanel projectId={project.id} refreshKey={workspaceRefresh} autoReview={autoReview} activeTab={workspaceTab} initialTab="code" onApplied={proposalApplied} />}
      {tab === 'files' && <WorkspacePanel projectId={project.id} refreshKey={workspaceRefresh} autoReview={autoReview} activeTab="files" initialTab="files" onApplied={proposalApplied} />}
      {tab === 'tools' && <GitHubTools projectId={project.id} projectName={project.name} connected={githubConnected} repoUrl={project.github_repo_url ?? null} />}
    </section>

    <nav className="pwa-bottom-nav fixed bottom-0 left-1/2 z-50 flex h-[65px] w-full items-center justify-around border-t border-zinc-800 bg-[#09090b]/96 px-3 backdrop-blur-xl md:hidden">
      <button onClick={()=>setTab('chat')} className={`flex h-full w-20 flex-col items-center justify-center gap-1 ${tab==='chat'?'text-violet-300':'text-zinc-500'}`}><MessageSquare size={22}/><span className="text-[10px]">Chat</span></button>
      <button onClick={()=>openWorkspace('code')} className={`flex h-full w-20 flex-col items-center justify-center gap-1 ${tab==='code'&&workspaceTab==='code'?'text-violet-300':'text-zinc-500'}`}><Code2 size={22}/><span className="text-[10px]">Code</span></button>
      <button onClick={()=>setTab('files')} className={`flex h-full w-20 flex-col items-center justify-center gap-1 ${tab==='files'?'text-violet-300':'text-zinc-500'}`}><Files size={22}/><span className="text-[10px]">Files</span></button>
      <button onClick={()=>setTab('tools')} className={`flex h-full w-20 flex-col items-center justify-center gap-1 ${tab==='tools'?'text-violet-300':'text-zinc-500'}`}><Zap size={22}/><span className="text-[10px]">Tools</span></button>
    </nav>

    <ProjectModal open={newOpen} onClose={()=>setNewOpen(false)} />
    {deleteOpen && <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 px-4 backdrop-blur-sm" onMouseDown={()=>setDeleteOpen(false)}><div className="w-full max-w-[350px] rounded-3xl border border-zinc-800 bg-[#121214] p-5" onMouseDown={e=>e.stopPropagation()}><div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Delete project?</h2><button onClick={()=>setDeleteOpen(false)} className="text-zinc-500"><X size={18}/></button></div><p className="text-sm text-zinc-500">This removes <span className="text-zinc-300">{project.name}</span> and cannot be undone.</p><form action={()=>deleteProject(project.id)} className="mt-5 flex gap-2"><button type="button" onClick={()=>setDeleteOpen(false)} className="h-11 flex-1 rounded-xl border border-zinc-800">Cancel</button><button className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-red-500/15 text-red-300"><Trash2 size={17}/>Delete</button></form></div></div>}
  </main>;
}

