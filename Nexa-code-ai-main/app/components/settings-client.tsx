'use client';

import { useState } from 'react';
import { Eye, EyeOff, CheckCircle2, Loader2, KeyRound } from 'lucide-react';

type Provider = 'gemini' | 'groq' | 'openrouter';
type KeyStatus = { provider: string; key_name: string };
const providers: { id: Provider; title: string; hint: string }[] = [
  { id: 'gemini', title: 'Gemini', hint: 'Google AI Studio' },
  { id: 'groq', title: 'Groq', hint: 'Fast inference' },
  { id: 'openrouter', title: 'OpenRouter', hint: 'Multi-model routing' }
];

export function SettingsClient({ initialKeys }: { initialKeys: KeyStatus[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, string>>({});

  async function save(provider: Provider, keyName: string) {
    const id = `${provider}-${keyName}`; setBusy(id); setNotice(n => ({...n, [id]: ''}));
    const res = await fetch('/api/keys', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ provider, keyName, apiKey: values[id] ?? '' }) });
    const data = await res.json().catch(() => ({}));
    setNotice(n => ({...n, [id]: res.ok ? 'Saved securely.' : (data.error ?? 'Save failed.') }));
    setBusy(null);
  }

  async function test(provider: Provider, keyName: string) {
    const id = `${provider}-${keyName}`; const key = values[id] ?? '';
    if (!key) { setTests(t => ({...t, [id]: 'Enter a key first.'})); return; }
    setBusy(`test-${id}`); setTests(t => ({...t, [id]: 'Testing stream…'}));
    try {
      const res = await fetch('/api/test-key', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({provider,apiKey:key}) });
      if (!res.body) throw new Error('No streaming response.');
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer=''; let ok=false; let error='';
      while(true){ const {value,done}=await reader.read(); if(done) break; buffer += decoder.decode(value,{stream:true}); const events=buffer.split(/\r?\n\r?\n/); buffer=events.pop()??''; for(const event of events){ const line=event.split(/\r?\n/).find(x=>x.startsWith('data:')); if(!line) continue; const payload=JSON.parse(line.slice(5).trim()); if(payload.type==='done') ok=true; if(payload.type==='error') error=payload.message; }}
      setTests(t=>({...t,[id]: error || (ok ? 'Streaming test passed.' : 'Test ended without confirmation.')}));
    } catch(e){ setTests(t=>({...t,[id]:e instanceof Error?e.message:'Test failed.'})); }
    setBusy(null);
  }

  return <div className="space-y-4">
    <div className="rounded-2xl border border-violet-500/20 bg-violet-500/5 p-4 text-sm text-zinc-300"><div className="flex items-center gap-2 font-medium text-violet-200"><KeyRound size={17}/>Bring your own key</div><p className="mt-2 text-xs leading-5 text-zinc-500">Keys are encrypted before they are stored. Nexa never sends your saved keys to the browser after saving.</p></div>
    {providers.map(p=><section key={p.id} className="rounded-3xl border border-zinc-800 bg-[#10131f] p-4"><div className="mb-4"><h2 className="font-semibold">{p.title}</h2><p className="text-xs text-zinc-500">{p.hint}</p></div><div className="space-y-3">{['Key 1','Key 2','Key 3'].map(name=>{const id=`${p.id}-${name}`; const saved=initialKeys.some(k=>k.provider===p.id&&k.key_name===name); return <div key={id} className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3"><label className="mb-2 flex items-center justify-between text-xs text-zinc-400"><span>{name} {saved && <span className="ml-1 text-emerald-400">• saved</span>}</span><button type="button" onClick={()=>setVisible(v=>({...v,[id]:!v[id]}))} className="text-zinc-500">{visible[id]?<EyeOff size={16}/>:<Eye size={16}/>}</button></label><input value={values[id]??''} onChange={e=>setValues(v=>({...v,[id]:e.target.value}))} type={visible[id]?'text':'password'} placeholder={saved?'Saved key — enter a new value to replace':'Paste API key'} className="h-11 w-full rounded-xl border border-zinc-800 bg-[#09090b] px-3 text-sm outline-none focus:border-violet-500"/><div className="mt-2 flex gap-2"><button disabled={busy===id} onClick={()=>save(p.id,name)} className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-violet-600 text-sm font-medium disabled:opacity-50">{busy===id?<Loader2 className="animate-spin" size={16}/>:<CheckCircle2 size={16}/>}Save</button><button disabled={busy===`test-${id}`} onClick={()=>test(p.id,name)} className="h-10 rounded-xl border border-zinc-700 px-4 text-sm text-zinc-200 disabled:opacity-50">{busy===`test-${id}`?<Loader2 className="animate-spin" size={16}/>: 'Test'}</button></div>{notice[id]&&<p className="mt-2 text-[11px] text-zinc-500">{notice[id]}</p>}{tests[id]&&<p className={`mt-2 text-[11px] ${tests[id].includes('passed')?'text-emerald-400':'text-amber-300'}`}>{tests[id]}</p>}</div>})}</div></section>)}
  </div>;
}
