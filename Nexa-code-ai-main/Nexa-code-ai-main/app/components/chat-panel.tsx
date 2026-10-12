'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AtSign, Bot, Check, Copy, Loader2, Paperclip, Plus, Send, Sparkles, GitCompareArrows } from 'lucide-react';

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

// A saved [PROPOSAL_READY] marker only counts if no proposal was generated after it.
function isConcreteEditRequest(text: string) {
  return /\b(fix|debug|repair|resolve|solve|error|bug|broken|crash|fails?|failing|not working|doesn'?t work|issue|problem|change|modify|update|replace|remove|delete|rename|adjust|make|add|improve|refactor|restore|decode|encode|deploy|build|vercel|typescript|json|package\.json|compile|compilation|runtime)\b/i.test(text);
}

function hasPendingProposalMarker(messages: Message[]) {
  let marker = -1; let generated = -1;
  messages.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    if (m.content.includes('[PROPOSAL_READY]')) marker = i;
    if (m.content.startsWith('Proposal ready')) generated = i;
  });
  return marker > generated;
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

export function ChatPanel({ projectId, initialMessages, initialProposal, onProposalGenerated, onReviewChanges, appliedSignal = 0 }: { projectId: string; initialMessages: Message[]; initialProposal?: { id: string; status: string; changesCount: number } | null; onProposalGenerated?: (proposalId: string) => void; onReviewChanges?: () => void; appliedSignal?: number }) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState('');
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [switchingProvider, setSwitchingProvider] = useState('');
  const [keysExhausted, setKeysExhausted] = useState<{ tried: any[]; message: string; retryAfter: number } | null>(null);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [mode, setMode] = useState<'conversation' | 'agent'>('conversation');
  const [proposalReady, setProposalReady] = useState(hasPendingProposalMarker(initialMessages));
  const [proposalId, setProposalId] = useState(initialProposal?.status === 'pending' ? initialProposal.id : '');
  const [changesCount, setChangesCount] = useState(initialProposal?.status === 'pending' ? initialProposal.changesCount : 0);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const history = useMemo(() => messages.map(({role,content})=>({role,content})), [messages]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' }); }, [messages, streaming]);
  useEffect(() => { if (appliedSignal > 0) { setProposalId(''); setChangesCount(0); } }, [appliedSignal]);
  useEffect(() => {
    if (!keysExhausted) return;
    setRetryCountdown(keysExhausted.retryAfter);
    const id = window.setInterval(() => setRetryCountdown(v => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(id);
  }, [keysExhausted]);
  useEffect(() => {
    if (retryCountdown !== 0 || !keysExhausted || streaming || generating) return;
    setKeysExhausted(null); setError('');
  }, [retryCountdown, keysExhausted, streaming, generating]);

  async function send(textOverride?: string, modeOverride?: 'conversation' | 'agent') {
    const text = (textOverride ?? input).trim(); if (!text || streaming || generating) return;
    const activeMode = modeOverride ?? mode;
    setInput(''); setError(''); setKeysExhausted(null); setSwitchingProvider(''); setStreaming(true);
    const userMessage: Message = { role: 'user', content: text, created_at: new Date().toISOString() };
    const assistantMessage: Message = { role: 'assistant', content: '', created_at: new Date().toISOString() };
    let assistantText = '';
    let shouldBuildInAgent = false;
    setMessages(prev => [...prev, userMessage, assistantMessage]);
    try {
      const response = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({projectId,message:text,history,provider:'cleanapis',mode:activeMode}) });
      if (!response.ok || !response.body) { const data=await response.json().catch(()=>({})); throw new Error(data.message || data.error || 'Nexa could not start the conversation.'); }
      const reader=response.body.getReader(); const decoder=new TextDecoder(); const parser=sseParser(); let done=false;
      while(!done){ const {value,done:readDone}=await reader.read(); if(readDone) break; const events=parser.push(decoder.decode(value,{stream:true})); for(const event of events){
        if(event.type==='chunk'){ window.dispatchEvent(new CustomEvent('nexa-ai-status',{detail:switchingProvider==='groq'?'fallback':'primary'})); } if(event.type==='chunk') { assistantText += event.text; setMessages(prev=>{const copy=[...prev]; const last=copy[copy.length-1]; if(last?.role==='assistant') copy[copy.length-1]={...last,content:last.content+event.text}; return copy;}); }
        if(event.type==='done'){
          done=true;
          setSwitchingProvider('');
          // Agent mode immediately starts the build/edit/fix pipeline.
          // Conversation mode never triggers file generation.
          if (activeMode === 'agent') shouldBuildInAgent = true;
          else if (event.proposalReady) setProposalReady(true);
        }
        if(event.type==='switching'){ setSwitchingProvider(event.provider); window.dispatchEvent(new CustomEvent('nexa-ai-status',{detail:event.provider==='groq'?'fallback':'primary'})); }
        if(event.type==='keys_exhausted'){ setKeysExhausted({tried:event.tried ?? [],message:event.message ?? 'All configured keys are rate-limited or invalid.',retryAfter:event.retryAfter ?? 60}); setError(''); window.dispatchEvent(new CustomEvent('nexa-ai-status',{detail:'exhausted'})); throw new Error('KEYS_EXHAUSTED'); }
        if(event.type==='provider_error'){ setError(event.message || 'AI providers could not complete the request right now.'); window.dispatchEvent(new CustomEvent('nexa-ai-status',{detail:'fallback'})); throw new Error('AI_UNAVAILABLE'); }
        if(event.type==='error') throw new Error(event.message);
        if(event.type==='warning') setError(event.message);
      }}
    } catch(e) { const msg=e instanceof Error?e.message:'Something went wrong.'; if(msg !== 'KEYS_EXHAUSTED') setError(msg); setMessages(prev=>prev[prev.length-1]?.role==='assistant' && !prev[prev.length-1].content ? prev.slice(0,-1) : prev); }
    finally {
      setStreaming(false);
      setSwitchingProvider('');
      setTimeout(()=>inputRef.current?.focus(), 50);
    }
    if (shouldBuildInAgent) {
      const completedHistory = [
        ...history,
        userMessage,
        { role: 'assistant' as const, content: assistantText, created_at: new Date().toISOString() },
      ];
      await generateProposal(completedHistory);
    }
  }

  function sendPromptToAgent(prompt: string) {
    const cleanPrompt = prompt.replace(/\[PROPOSAL_READY\]/g, '').trim();
    setMode('agent');
    void send(cleanPrompt, 'agent');
  }

  function sendCompletionReportToConversation() {
    const report = `Agent task status\nTask ID: ${proposalId || 'not generated'}\nFiles proposed: ${changesCount}\nStatus: Changes are prepared for review; they have not been applied yet.\nPlease continue planning based on this status and suggest the next step.`;
    setMode('conversation');
    void send(report, 'conversation');
  }

  async function generateProposal(historyOverride?: { role: 'user' | 'assistant'; content: string }[]) {
    if (generating || (streaming && !historyOverride) || (!historyOverride && !proposalReady && mode !== 'agent')) return;
    setGenerating(true); setError('');
    try {
      const response = await fetch('/api/generate-proposal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, history: historyOverride ?? history }) });
      const raw = await response.text();
      let data: { proposalId?: string; changesCount?: number; error?: string; message?: string } = {};

      if (raw.trim()) {
        try {
          data = JSON.parse(raw);
        } catch {
          const detail = raw.replace(/\s+/g, ' ').trim();
          throw new Error(detail || `Agent build returned an invalid response (HTTP ${response.status}).`);
        }
      }

      if (!response.ok) {
        throw new Error(data.error || data.message || `Agent build failed (HTTP ${response.status}).`);
      }
      if (!data.proposalId) {
        throw new Error('Agent did not return a completed set of file changes. Please try again.');
      }

      const summary = `Proposal ready: ${data.changesCount ?? 0} ${(data.changesCount ?? 0) === 1 ? 'file' : 'files'} to modify.`;
      setMessages(prev => [...prev, { role: 'assistant', content: summary, created_at: new Date().toISOString() }]);
      setProposalId(data.proposalId); setChangesCount(data.changesCount ?? 0); setProposalReady(false);
      onProposalGenerated?.(data.proposalId);
    } catch (e) { setError(e instanceof Error ? e.message : 'Nexa could not generate a proposal.'); }
    finally { setGenerating(false); }
  }

  async function copyMessage(content: string, messageKey: string) {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(content);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = content;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!copied) throw new Error('Clipboard copy was blocked');
      }
      setCopiedMessageKey(messageKey);
      window.setTimeout(() => setCopiedMessageKey(current => current === messageKey ? null : current), 1600);
    } catch {
      setError('Could not copy this message. Please select the text and copy it manually.');
    }
  }

  return <div className="space-y-3 pb-52">
    {messages.length === 0 && <article className="rounded-3xl border border-zinc-800 bg-[#10131f] p-5"><div className="flex gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-violet-500/20 text-violet-200"><Sparkles size={21}/></div><div><div className="font-semibold text-indigo-100">NEXA</div><p className="mt-2 text-sm leading-6 text-zinc-400">Use Conversation Mode to discuss and prepare a final prompt. Switch to Agent Mode when you want Nexa to inspect the project and prepare file changes.</p></div></div></article>}
    {messages.map((message,i)=>{ const messageKey = message.id ?? `${message.created_at ?? 'message'}-${i}`; return <article key={messageKey} className={`rounded-3xl border border-zinc-800 p-4 ${message.role==='assistant'?'bg-[#10131f]':'bg-[#0d1425]'}`}><div className="flex gap-3"><div className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${message.role==='assistant'?'bg-violet-500/20 text-violet-200':'bg-indigo-500/20 text-indigo-200'}`}>{message.role==='assistant'?<Sparkles size={20}/>:<span className="text-xs font-bold">You</span>}</div><div className="min-w-0 flex-1"><div className="mb-2 flex items-center justify-between"><span className="font-semibold text-indigo-100">{message.role==='assistant'?'NEXA':'You'}</span><span className="text-[10px] text-zinc-600">{message.created_at ? new Date(message.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''}</span></div>{message.content ? <><Markdown content={message.content}/>
          {message.role === 'assistant' && message.content.includes('[PROPOSAL_READY]') && mode === 'conversation' && <div className="mt-3"><button type="button" onClick={() => sendPromptToAgent(message.content)} disabled={streaming || generating} className="rounded-xl border border-violet-400/50 bg-violet-600/20 px-3 py-2 text-xs font-semibold text-violet-100 hover:bg-violet-600/30 disabled:opacity-40"><Bot size={14} className="mr-1 inline"/>Send this prompt to Agent</button></div>}
          <div className="mt-3 flex justify-end"><button type="button" onClick={() => void copyMessage(message.content, messageKey)} aria-label={copiedMessageKey === messageKey ? 'Message copied' : 'Copy message'} title={copiedMessageKey === messageKey ? 'Copied' : 'Copy message'} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-900/70 px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-violet-500/60 hover:bg-violet-500/10 hover:text-violet-200 focus:outline-none focus:ring-2 focus:ring-violet-500/50">{copiedMessageKey === messageKey ? <Check size={13}/> : <Copy size={13}/>}<span>{copiedMessageKey === messageKey ? 'Copied' : 'Copy'}</span></button></div></> : streaming && <div className="flex items-center gap-1 py-2"><span className="h-2 w-2 animate-bounce rounded-full bg-violet-400"/><span className="h-2 w-2 animate-bounce rounded-full bg-violet-400 [animation-delay:120ms]"/><span className="h-2 w-2 animate-bounce rounded-full bg-violet-400 [animation-delay:240ms]"/></div>}</div></div></article>})}
    {keysExhausted && <div className="bg-red-500/10 border border-red-500 text-red-400 p-3 rounded">
      <div>⚠️ All configured AI keys are currently rate-limited or invalid — {keysExhausted.tried.map((item: any) => `${item.provider} (${item.keysTried ?? 0} key${item.keysTried === 1 ? '' : 's'} tried)`).join(', ')}. Cooldown {retryCountdown}s active. Add a working key in Settings or wait for the cooldown.</div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Link href="/app/settings/ai-keys" className="font-semibold underline">Go to Settings → AI Keys</Link>
        <span className="font-mono text-xs">{retryCountdown}s · auto-retry ready</span>
      </div>
    </div>}
    {switchingProvider && <div className="rounded-2xl border border-violet-500/20 bg-violet-500/5 px-4 py-3 text-xs text-violet-200">Nexa is switching providers… trying {switchingProvider} next.</div>}
    {error && <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-5 text-amber-200">{error}</div>}
    {generating && <div className="flex w-full items-center justify-center gap-2 rounded-2xl border border-violet-400/50 bg-violet-600/20 px-4 py-3 text-sm font-semibold text-violet-100"><Loader2 size={17} className="animate-spin"/>Agent is building, editing, or fixing your project…</div>}
    {proposalId && changesCount > 0 && <><button onClick={onReviewChanges} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-violet-500/40 bg-violet-500/10 px-4 py-3 text-sm font-semibold text-violet-200"><GitCompareArrows size={17}/>Review Changes · {changesCount}</button><button onClick={sendCompletionReportToConversation} disabled={streaming || generating} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-zinc-700 bg-zinc-900/70 px-4 py-2.5 text-xs font-semibold text-zinc-300 disabled:opacity-40">↩ Send status report to Conversation</button></>}
    <div ref={endRef}/>

    <div className="fixed bottom-[65px] left-0 right-0 z-40 w-full px-3 pb-2">
      <div className="rounded-[24px] border border-violet-500/80 bg-[#0b1021]/96 p-2 shadow-[0_0_35px_rgba(76,29,149,.45)] backdrop-blur-xl">
        <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-indigo-300"><Sparkles size={14}/><span>Choose how Nexa should respond</span></div>
        <div className="grid grid-cols-2 gap-2 px-2 pb-2">
          <button type="button" onClick={() => setMode('conversation')} aria-pressed={mode === 'conversation'} className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${mode === 'conversation' ? 'border-violet-400 bg-violet-500/20 text-violet-100' : 'border-zinc-700 bg-zinc-900/60 text-zinc-400'}`}>💬 Conversation</button>
          <button type="button" onClick={() => setMode('agent')} aria-pressed={mode === 'agent'} className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${mode === 'agent' ? 'border-violet-400 bg-violet-500/20 text-violet-100' : 'border-zinc-700 bg-zinc-900/60 text-zinc-400'}`}>🤖 Agent</button>
        </div>
        <div className="px-2 pb-1 pt-2"><input ref={inputRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}} placeholder="Tell Nexa what to build, fix, or improve..." className="w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500" disabled={streaming || generating}/></div>
        <div className="flex items-center gap-2 px-1 pb-1 pt-1"><button className="grid h-11 w-11 place-items-center rounded-full bg-zinc-900 text-zinc-300"><Plus/></button><button className="grid h-11 w-11 place-items-center rounded-full bg-zinc-900 text-zinc-300"><Paperclip/></button><button className="hidden h-11 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-sm text-zinc-200 sm:flex"><AtSign size={17}/>Files</button><button onClick={() => setMode(mode === 'conversation' ? 'agent' : 'conversation')} disabled={streaming || generating} className="ml-auto flex h-11 items-center gap-2 rounded-full border border-violet-500/80 bg-violet-500/10 px-3 text-xs text-violet-200 disabled:opacity-40">{mode === 'conversation' ? <Bot size={17}/> : <Sparkles size={17}/>} {mode === 'conversation' ? 'Use Agent' : 'Use Chat'}</button><button onClick={() => void send()} disabled={streaming || generating || !input.trim()} className="grid h-11 w-11 place-items-center rounded-full bg-white text-black shadow-[0_0_22px_rgba(139,92,246,.65)] disabled:opacity-40"><Send size={19} fill="currentColor"/></button></div>
      </div>
    </div>
  </div>;
}
