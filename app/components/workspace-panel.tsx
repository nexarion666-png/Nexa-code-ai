'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Code2, Eye, FileCode2, Files, Folder, Loader2, X, Download, GitCompareArrows, TerminalSquare, RefreshCw, ExternalLink } from 'lucide-react';
import { PreviewFrame } from '@/components/PreviewFrame';

type FileRow = { id: string; path: string; content: string | null; updated_at: string };
type Change = { id: string; path: string; operation: 'create' | 'update' | 'delete'; old_content: string | null; new_content: string | null };
type Proposal = { id: string; status: string; created_at: string } | null;
type InnerTab = 'code' | 'files' | 'preview';

export function WorkspacePanel({ projectId, refreshKey, autoReview, initialTab, activeTab, onApplied }: { projectId: string; refreshKey: number; autoReview?: number; initialTab?: InnerTab; activeTab?: InnerTab; onApplied?: () => void }) {
  const [innerTab, setInnerTab] = useState<InnerTab>(activeTab ?? initialTab ?? 'code');
  const [files, setFiles] = useState<FileRow[]>([]);
  const [proposal, setProposal] = useState<Proposal>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [logsOpen, setLogsOpen] = useState(false);
  const [selectionTimer, setSelectionTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { if (activeTab) setInnerTab(activeTab); }, [activeTab]);
  useEffect(() => () => { if (selectionTimer) clearTimeout(selectionTimer); }, [selectionTimer]);

  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/project-files?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load project files.');
      setFiles(data.files ?? []); setProposal(data.latestProposal ?? null); setChanges(data.changes ?? []);
      if (!selectedPath && data.files?.[0]?.path) setSelectedPath(data.files[0].path);
      if (selectedPath && data.files?.length && !data.files.some((file: FileRow) => file.path === selectedPath)) setSelectedPath(data.files[0]?.path ?? '');
      if (autoReview && data.latestProposal?.status === 'pending' && (data.changes?.length ?? 0) > 0) setReviewOpen(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load project files.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [projectId, refreshKey, autoReview]);

  const selected = files.find(file => file.path === selectedPath) ?? files[0];
  const pendingPaths = useMemo(() => new Set(changes.map(change => change.path)), [changes]);
  const pendingCount = proposal?.status === 'pending' ? changes.length : 0;

  function selectPath(path: string) {
    if (selectionTimer) clearTimeout(selectionTimer);
    const timer = setTimeout(() => setSelectedPath(path), 80);
    setSelectionTimer(timer);
  }

  async function applyProposal() {
    if (!proposal) return;
    setApplying(true); setError('');
    try {
      const response = await fetch('/api/apply-proposal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalId: proposal.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not apply changes.');
      setReviewOpen(false);
      await load();
      onApplied?.();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not apply changes.'); }
    finally { setApplying(false); }
  }

  async function downloadZip() {
    const response = await fetch('/api/download-zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId }) });
    if (!response.ok) { setError(await response.text()); return; }
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'nexa-project.zip'; anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className="space-y-3">
    <div className="scrollbar-none flex gap-1 overflow-x-auto rounded-2xl border border-zinc-800 bg-[#0d0d10] p-1">
      {([['code','Code',Code2],['files','Files',Files],['preview','Preview',Eye]] as const).map(([key,label,Icon]) => <button key={key} onClick={() => setInnerTab(key)} className={`flex h-10 min-w-[88px] flex-1 items-center justify-center gap-2 rounded-xl text-sm ${innerTab === key ? 'bg-zinc-800 text-white' : 'text-zinc-500'}`}><Icon size={17}/>{label}</button>)}
    </div>

    {pendingCount > 0 && <div className="rounded-3xl border border-violet-500/30 bg-[#11101b] p-5 text-center shadow-[0_0_28px_rgba(139,92,246,.12)]">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-violet-500/15 text-violet-200"><GitCompareArrows size={23}/></div>
      <h2 className="mt-3 text-base font-semibold text-white">Changes ready for review</h2>
      <p className="mt-1 text-sm text-zinc-500">{changes.length} {changes.length === 1 ? 'file' : 'files'} to modify</p>
      <div className="mt-4 flex gap-2"><button onClick={() => setReviewOpen(true)} className="h-11 flex-1 rounded-xl border border-zinc-700 bg-zinc-900 text-sm font-medium text-white">Review changes</button><button onClick={applyProposal} disabled={applying} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-violet-600 text-sm font-semibold text-white shadow-[0_0_22px_rgba(139,92,246,.28)]">{applying ? <Loader2 size={17} className="animate-spin"/> : <Check size={17}/>}Apply changes</button></div>
    </div>}

    {error && <div className="rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-200">{error}</div>}
    {loading ? <div className="grid min-h-[250px] place-items-center rounded-3xl border border-zinc-800 bg-[#0a0a0a]"><Loader2 className="animate-spin text-violet-300"/></div> : innerTab === 'code' ? <CodeView file={selected} files={files} onSelect={selectPath} pendingPaths={pendingPaths} onDownload={downloadZip}/> : innerTab === 'files' ? <FileTree files={files} selectedPath={selected?.path ?? ''} onSelect={selectPath} pendingPaths={pendingPaths} onDownload={downloadZip}/> : <PreviewFrame projectId={projectId}/>} 

    <LogsPanel proposal={proposal} changeCount={changes.length} appliedCount={proposal?.status === 'applied' ? changes.length : 0} open={logsOpen} onToggle={() => setLogsOpen(value => !value)} />
    {reviewOpen && <ReviewDrawer changes={changes} applying={applying} onClose={() => setReviewOpen(false)} onApply={applyProposal}/>} 
  </div>;
}

function CodeView({ file, files, onSelect, pendingPaths, onDownload }: { file?: FileRow; files: FileRow[]; onSelect: (path: string) => void; pendingPaths: Set<string>; onDownload: () => void }) {
  return <div className="overflow-hidden rounded-3xl border border-zinc-800 bg-[#0a0a0a]"><div className="flex items-center gap-2 overflow-x-auto border-b border-zinc-800 px-2 py-2">{files.map(item => <button key={item.path} onClick={() => onSelect(item.path)} className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs ${file?.path === item.path ? 'bg-zinc-800 text-white' : 'text-zinc-500'}`}><FileCode2 size={14}/>{item.path}{pendingPaths.has(item.path) && <span className="h-1.5 w-1.5 rounded-full bg-violet-400"/>}</button>)}<button onClick={onDownload} className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-zinc-800 text-zinc-500"><Download size={15}/></button></div>{file ? <><div className="flex items-center justify-between border-b border-zinc-900 px-4 py-2 text-[11px] text-zinc-500"><span>{file.path}</span><span>code</span></div><pre className="max-h-[58vh] min-h-[280px] overflow-auto p-4 text-[12px] leading-5 text-zinc-300"><code>{file.content ?? ''}</code></pre></> : <EmptyCode/>}</div>;
}

function FileTree({ files, selectedPath, onSelect, pendingPaths, onDownload }: { files: FileRow[]; selectedPath: string; onSelect: (path: string) => void; pendingPaths: Set<string>; onDownload: () => void }) {
  return <div className="overflow-hidden rounded-3xl border border-zinc-800 bg-[#0a0a0a]"><div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3"><span className="text-sm font-medium">Project files</span><button onClick={onDownload} className="grid h-8 w-8 place-items-center rounded-lg border border-zinc-800 text-zinc-500"><Download size={15}/></button></div>{files.length ? <div className="max-h-[58vh] overflow-auto p-2">{files.map(file => <button key={file.path} onClick={() => onSelect(file.path)} className={`flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left text-xs ${selectedPath === file.path ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900'}`}><Folder size={15} className="text-indigo-400"/><span className="min-w-0 flex-1 truncate">{file.path}</span>{pendingPaths.has(file.path) && <span title="Pending change" className="h-2 w-2 rounded-full bg-violet-400"/>}<ChevronRight size={14} className="text-zinc-700"/></button>)}</div> : <EmptyCode/>}</div>;
}

function EmptyCode() { return <div className="grid min-h-[280px] place-items-center p-8 text-center"><div><Files className="mx-auto text-zinc-700" size={35}/><p className="mt-3 text-sm text-zinc-400">No files yet.</p><p className="mt-1 text-xs text-zinc-600">Start conversation to generate your app</p></div></div>; }

function LogsPanel({ proposal, changeCount, appliedCount, open, onToggle }: { proposal: Proposal; changeCount: number; appliedCount: number; open: boolean; onToggle: () => void }) {
  return <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-[#111113]"><button onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left"><TerminalSquare size={16} className="text-zinc-500"/><span className="flex-1 text-xs font-medium text-zinc-300">Build logs</span><span className="text-[10px] text-zinc-600">{open ? 'Hide' : 'Show'}</span>{open ? <ChevronRight size={15} className="rotate-90 text-zinc-600"/> : <ChevronRight size={15} className="text-zinc-600"/>}</button>{open && <div className="grid gap-2 border-t border-zinc-800 p-3 text-xs"><div className="rounded-xl bg-zinc-950 px-3 py-2 text-zinc-500">Build logs <span className="float-right text-zinc-300">Ready</span></div><div className="rounded-xl bg-zinc-950 px-3 py-2 text-zinc-500">Applied <span className="float-right text-zinc-300">{appliedCount} files</span></div><div className="rounded-xl bg-zinc-950 px-3 py-2 text-zinc-500">Last proposal status <span className="float-right capitalize text-zinc-300">{proposal?.status ?? 'none'}</span></div>{proposal?.created_at && <div className="px-1 text-[10px] text-zinc-700">Last proposal {new Date(proposal.created_at).toLocaleString()}</div>}<button onClick={() => window.location.reload()} className="flex items-center justify-center gap-2 rounded-xl border border-zinc-800 py-2 text-zinc-400"><RefreshCw size={13}/>Refresh workspace</button></div>}</div>;
}

function ReviewDrawer({ changes, applying, onClose, onApply }: { changes: Change[]; applying: boolean; onClose: () => void; onApply: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(changes[0]?.id ?? null);
  return <div className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm" onMouseDown={onClose}><aside className="absolute right-0 top-0 flex h-full w-full max-w-[430px] flex-col border-l border-zinc-800 bg-[#0d0d10] shadow-2xl" onMouseDown={e => e.stopPropagation()}><div className="flex items-center justify-between border-b border-zinc-800 px-4 py-4"><div><h2 className="font-semibold">Review Changes</h2><p className="mt-1 text-xs text-zinc-500">{changes.length} files in this proposal</p></div><button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl bg-zinc-900 text-zinc-400"><X size={18}/></button></div><div className="flex-1 overflow-auto p-3">{changes.map(change => <div key={change.id} className="mb-2 overflow-hidden rounded-2xl border border-zinc-800 bg-[#101012]"><button onClick={() => setExpanded(expanded === change.id ? null : change.id)} className="flex w-full items-center gap-3 px-3 py-3 text-left"><span className="truncate text-xs text-zinc-200">{change.path}</span><span className={`ml-auto rounded-full px-2 py-1 text-[10px] font-medium ${change.operation === 'create' ? 'bg-emerald-500/10 text-emerald-300' : change.operation === 'update' ? 'bg-amber-500/10 text-amber-300' : 'bg-red-500/10 text-red-300'}`}>{change.operation}</span></button>{expanded === change.id && <DiffView change={change}/>}</div>)}</div><div className="flex gap-2 border-t border-zinc-800 p-3"><button onClick={onClose} className="h-11 flex-1 rounded-xl border border-zinc-800 text-sm text-zinc-300">Close</button><button onClick={onApply} disabled={applying} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-violet-600 text-sm font-semibold text-white">{applying && <Loader2 size={16} className="animate-spin"/>}Apply All</button></div></aside></div>;
}

function DiffView({ change }: { change: Change }) {
  if (change.operation === 'create') return <pre className="max-h-72 overflow-auto border-t border-zinc-800 bg-[#080808] p-3 text-[11px] leading-5 text-emerald-200">{change.new_content ?? ''}</pre>;
  if (change.operation === 'delete') return <pre className="max-h-72 overflow-auto border-t border-zinc-800 bg-[#080808] p-3 text-[11px] leading-5 text-red-200">{change.old_content ?? ''}</pre>;
  const oldLines = (change.old_content ?? '').split('\n'); const newLines = (change.new_content ?? '').split('\n'); const max = Math.max(oldLines.length, newLines.length);
  return <div className="grid max-h-80 grid-cols-2 overflow-auto border-t border-zinc-800 text-[10px] leading-5"><div className="min-w-0 border-r border-zinc-800">{Array.from({length:max},(_,i)=><div key={i} className="whitespace-pre-wrap break-words bg-red-500/[0.04] px-2 text-red-200/80">{oldLines[i] ?? ''}</div>)}</div><div className="min-w-0">{Array.from({length:max},(_,i)=><div key={i} className="whitespace-pre-wrap break-words bg-emerald-500/[0.04] px-2 text-emerald-200/80">{newLines[i] ?? ''}</div>)}</div></div>;
}
