'use client';

import { useState } from 'react';
import { Eye, EyeOff, Github, Loader2, Link2Off, CheckCircle2 } from 'lucide-react';

export function GitHubSettings({ initialUsername }: { initialUsername: string | null }) {
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [username, setUsername] = useState(initialUsername);
  const [status, setStatus] = useState(initialUsername ? 'Connected' : '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setStatus('');
    try {
      const res = await fetch('/api/github/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not connect GitHub.');
      setUsername(data.username); setToken(''); setStatus(`Connected as ${data.username}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Connection failed.'); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setStatus('Testing connection…');
    try {
      const res = await fetch('/api/github/connection', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.connected) throw new Error(data.error || 'GitHub is not connected.');
      setUsername(data.username); setStatus(`Connection verified as ${data.username}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Test failed.'); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true); setStatus('');
    try {
      const res = await fetch('/api/github/token', { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not disconnect GitHub.');
      setUsername(null); setStatus('GitHub disconnected.');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Disconnect failed.'); }
    finally { setBusy(false); }
  }

  return <section className="rounded-3xl border border-zinc-800 bg-[#10131f] p-4">
    <div className="flex items-start gap-3">
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-zinc-900 text-white"><Github size={22}/></div>
      <div className="min-w-0 flex-1"><h2 className="font-semibold">GitHub</h2><p className="mt-1 text-xs leading-5 text-zinc-500">Connect a GitHub Personal Access Token to create, push, and import repositories.</p></div>
      {username && <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>{username}</span>}
    </div>
    <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
      <label className="text-xs text-zinc-400">GitHub Personal Access Token</label>
      <div className="relative mt-2"><input value={token} onChange={e=>setToken(e.target.value)} type={visible?'text':'password'} placeholder={username ? 'Enter a new token to replace the saved token' : 'ghp_…'} className="h-11 w-full rounded-xl border border-zinc-800 bg-[#09090b] px-3 pr-11 text-sm outline-none focus:border-violet-500"/><button type="button" onClick={()=>setVisible(v=>!v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500">{visible?<EyeOff size={16}/>:<Eye size={16}/>}</button></div>
      <p className="mt-2 text-[11px] leading-5 text-zinc-600">Create at github.com/settings/tokens (classic) — check <span className="text-zinc-400">repo</span> scope.</p>
      <div className="mt-3 flex gap-2"><button onClick={save} disabled={busy || !token.trim()} className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-violet-600 text-sm font-medium disabled:opacity-50">{busy?<Loader2 size={15} className="animate-spin"/>:<CheckCircle2 size={15}/>}Save & Connect</button><button onClick={test} disabled={busy} className="h-10 rounded-xl border border-zinc-700 px-4 text-sm text-zinc-200 disabled:opacity-50">Test</button></div>
      {username && <button onClick={disconnect} disabled={busy} className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-red-500/20 text-xs text-red-300 disabled:opacity-50"><Link2Off size={14}/>Disconnect GitHub</button>}
      {status && <p className={`mt-2 text-[11px] ${status.toLowerCase().includes('connected') || status.toLowerCase().includes('verified') ? 'text-emerald-400' : 'text-amber-300'}`}>{status}</p>}
    </div>
  </section>;
}
