'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AtSign, Bot, Loader2, Paperclip, Plus, Send, Sparkles, GitCompareArrows } from 'lucide-react';

type Message = { id?: string; role: 'user' | 'assistant'; content: string; created_at?: string };

function Markdown({ content }: { content: string }) {
  const clean = content.replace(/\[PROPOSAL_READY\]/g, '').trim();
  const blocks = clean.split(/\n\s*\n/).filter(Boolean);
  return <div className="space-y-3 text-[15px] leading-6 text-zinc-200">{blocks.map((block, i) => {
    if (block.startsWith('```')) {
      const code = block.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/, '');
      return <pre key={i} className="overflow-x-auto rounded-xl border border-zinc-800 bg-[#08090d] p-3 text-xs leading-5 text-zinc-300"><code>{code}</code></pre>;
    }
    const parts = block.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return <p key={i}>{parts.map((part,j)=>part.startsWith('**') ? <strong key={j} className="font-semibold text-white">{part.slice(2,-2)}</strong> : part.startsWith('`') ? <code key={j} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-violet-200">{part.slice(1,-1)}</code> : part)}</p>;
  })}</div>;
}

function sseParser() {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      return events.map(event => event.split(/\r?\n/).find(line => line.startsWith('data:'))).filter(Boolean).map(line => JSON.parse((line as string).slice(5).trim()));
    },
  };
}

export function ChatPanel({ projectId, initialMessages, initialProposal, onProposalGenerated, onReviewChanges }: { projectId: string; initialMessages: Message[]; initialProposal?: { id: string; status: string; changesCount: number } | null; onProposalGenerated?: (proposalId: string) => void; onReviewChanges?: () => void }) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [switchingProvider, setSwitchingProvider] = useState('');
  const [keysExhausted, setKeysExhausted] = useState<{ tried: any[]; message: string; retryAfter: number } | null>(null);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [mode, setMode] = useState<'conversation' | 'agent'>('conversation');
  const [proposalReady, setProposalReady] = useState(initialMessages.some(m => m.role === 'assistant' && m.content.includes('[PROPOSAL_READY]')));
  const [proposalId, setProposalId] = useState(initialProposal?.status === 'pending' ? initialProposal.id : '');
  const [changesCount, setChangesCount] = useState(initialProposal?.status === 'pending' ? initialProposal.changesCount : 0);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const history = useMemo(() => messages.map(({role,content})=>({role,content})), [messages]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' }); }, [messages, streaming]);
  useEffect(() => {
    if (!keysExhausted) return;
    setRetryCountdown(keysExhausted.retryAfter);
    const id = window.setInterval(() => setRetryCountdown(v => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(id);
  }, [keysExhausted]);
  useEffect(() => {
    if (retryCountdown !== 0 || !keysExhausted || streaming || generating) return;
    setKeysExhausted(null);
  }, [retryCountdown, keysExhausted, streaming, generating]);

  async function send() {
    const text = input.trim(); if (!text || streaming || generating) return;
    setInput(''); setError(''); setKeysExhausted(null); setSwitchingProvider(''); setStreaming(true);
    const userMessage: Message = { role: 'user', content: text, created_at: new Date().toISOString() };
    const assistantMessage: Message = { role: 'assistant', content: '', created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMessage, assistantMessage]);
    try {
      const response = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({projectId,message:text,history,provider:'gemini'}) });
      if (!response.ok || !response.body) { const data=await response.json().catch(()=>({})); throw new Error(data.error || 'Nexa could not start the conversation.'); }
      const reader=response.body.getReader(); const decoder=new TextDecoder(); const parser=sseParser(); let done=false;
      while(!done){ const {value,done:readDone}=await reader.read(); if(readDone) break; const events=parser.push(decoder.decode(value,{stream:true})); for(const event of events){
        if(event.type==='chunk'){ window.dispatchEvent(new CustomEvent('nexa-ai-status',{detail:switchingProvider==='groq'?'fallback':'primary'})); } if(event.type==='chunk') setMessages(prev=>{const copy=[...prev]; const last=copy[copy.length-1]; if(last?.role==='assistant') copy[copy.length-1]={...last,content:last.content+event.text}; return copy;});
        if(event.type==='done'){ done=true; setSwitchingProvider(''); if(event.proposalReady) setProposalReady(true); }
        if(event.type==='switching'){ setSwitchingProvider(event.provider); window.dispatchEvent(new CustomEvent('nexa-ai-status',{detail:event.provider==='groq'?'fallback':'primary'})); }
        if(event.type==='keys_exhausted'){ setKeysExhausted({tried:event.tried ?? [],message:event.message ?? 'All keys exhausted',retryAfter:event.retryAfter ?? 60}); window.dispatchEvent(new CustomEvent('nexa-ai-status',{detail:'exhausted'})); throw new Error('KEYS_EXHAUSTED'); }
        if(event.type==='error') throw new Error(event.message);
        if(event.type==='warning') setError(event.message);
      }}
    } catch(e) { const msg=e instanceof Error?e.message:'Something went wrong.'; setError(msg); setMessages(prev=>prev[prev.length-1]?.role==='assistant' && !prev[prev.length-1].content ? prev.slice(0,-1) : prev); }
    finally { setStreaming(false); setSwitchingProvider(''); setTimeout(()=>inputRef.current?.focus(), 50); }
  }

  async function generateProposal() {
    if (generating || streaming || (!proposalReady && mode !== 'agent')) return;
    setGenerating(true); setError('');
    try {
      const response = await fetch('/api/generate-proposal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, history }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Nexa could not generate a proposal.');
      const summary = `Proposal ready: ${data.changesCount} ${data.changesCount === 1 ? 'file' : 'files'} to modify.`;
      setMessages(prev => [...prev, { role: 'assistant', content: summary, created_at: new Date().toISOString() }]);
      setProposalId(data.proposalId); setChangesCount(data.changesCount ?? 0); setProposalReady(false);
      onProposalGenerated?.(data.proposalId);
    } catch (e) { setError(e instanceof Error ? e.message : 'Nexa could not generate a proposal.'); }
    finally { setGenerating(false); }
  }

  return <div className="space-y-3 pb-52">
    {messages.length === 0 && <article className="rounded-3xl border border-zinc-800 bg-[#10131f] p-5"><div className="flex gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-violet-500/20 text-violet-200"><Sparkles size={21}/></div><div><div className="font-semibold text-indigo-100">NEXA</div><p className="mt-2 text-sm leading-6 text-zinc-400">Tell me what you want to build. I’ll ask the important questions about requirements, stack, features, and design before proposing anything.</p></div></div></article>}
    {messages.map((message,i)=><article key={message.id ?? `${message.created_at}-${i}`} className={`rounded-3xl border border-zinc-800 p-4 ${message.role==='assistant'?'bg-[#10131f]':'bg-[#0d1425]'}`}><div className="flex gap-3"><div className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${message.role==='assistant'?'bg-violet-500/20 text-violet-200':'bg-indigo-500/20 text-indigo-200'}`}>{message.role==='assistant'?<Sparkles size={20}/>:<span className="text-xs font-bold">You</span>}</div><div className="min-w-0 flex-1"><div className="mb-2 flex items-center justify-between"><span className="font-semibold text-indigo-100">{message.role==='assistant'?'NEXA':'You'}</span><span className="text-[10px] text-zinc-600">{message.created_at ? new Date(message.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''}</span></div>{message.content ? <Markdown content={message.content}/> : streaming && <div className="flex items-center gap-1 py-2"><span className="h-2 w-2 animate-bounce rounded-full bg-violet-400"/><span className="h-2 w-2 animate-bounce rounded-full bg-violet-400 [animation-delay:120ms]"/><span className="h-2 w-2 animate-bounce rounded-full bg-violet-400 [animation-delay:240ms]"/></div>}</div></div></article>)}
    {keysExhausted && <div className="bg-red-500/10 border border-red-500 text-red-400 p-3 rounded">
      <div>⚠️ All API keys exhausted — {keysExhausted.tried.map((item: any) => `${item.provider} (${item.keysTried ?? 0}/${item.keysTried ?? 0} keys hit rate limit)`).join(', ')}. Cooldown {retryCountdown}s active. Chat is on slow fallback. Add a key in Settings to restore speed.</div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Link href="/app/settings/ai-keys" className="font-semibold underline">Go to Settings → AI Keys</Link>
        <span className="font-mono text-xs">{retryCountdown}s · auto-retry ready</span>
      </div>
    </div>}
    {switchingProvider && <div className="rounded-2xl border border-violet-500/20 bg-violet-500/5 px-4 py-3 text-xs text-violet-200">Gemini is unavailable. Nexa is switching to {switchingProvider}…</div>}
    {error && <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-5 text-amber-200">{error}</div>}
    {proposalReady && <button onClick={generateProposal} disabled={generating} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-violet-400/50 bg-violet-600 px-4 py-3 text-sm font-semibold text-white shadow-[0_0_24px_rgba(139,92,246,.35)]">{generating ? <Loader2 size={17} className="animate-spin"/> : <GitCompareArrows size={17}/>}Generate Proposal</button>}
    {proposalId && changesCount > 0 && <button onClick={onReviewChanges} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-violet-500/40 bg-violet-500/10 px-4 py-3 text-sm font-semibold text-violet-200"><GitCompareArrows size={17}/>Review Changes · {changesCount}</button>}
    <div ref={endRef}/>

    <div className="fixed bottom-[65px] left-0 right-0 z-40 w-full px-3 pb-2">
      <div className="rounded-[24px] border border-violet-500/80 bg-[#0b1021]/96 p-2 shadow-[0_0_35px_rgba(76,29,149,.45)] backdrop-blur-xl">
        <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-indigo-300"><Sparkles size={14}/><span>Conversation Mode · Nexa asks before building</span></div>
        <div className="px-2 pb-1 pt-2"><input ref={inputRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}} placeholder="Tell Nexa what to build, fix, or improve..." className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500" disabled={streaming || generating}/></div>
        <div className="flex items-center gap-2 px-1 pb-1 pt-1"><button className="grid h-11 w-11 place-items-center rounded-full bg-zinc-900 text-zinc-300"><Plus/></button><button className="grid h-11 w-11 place-items-center rounded-full bg-zinc-900 text-zinc-300"><Paperclip/></button><button className="hidden h-11 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-sm text-zinc-200 sm:flex"><AtSign size={17}/>Files</button><button onClick={() => { setMode('agent'); setProposalReady(true); void generateProposal(); }} disabled={streaming || generating} className="ml-auto flex h-11 items-center gap-2 rounded-full border border-violet-500/80 bg-violet-500/10 px-4 text-sm text-violet-200 disabled:opacity-40"><Bot size={18}/>Agent</button><button onClick={send} disabled={streaming || generating || !input.trim()} className="grid h-11 w-11 place-items-center rounded-full bg-white text-black shadow-[0_0_22px_rgba(139,92,246,.65)] disabled:opacity-40"><Send size={19} fill="currentColor"/></button></div>
      </div>
    </div>
  </div>;
}
