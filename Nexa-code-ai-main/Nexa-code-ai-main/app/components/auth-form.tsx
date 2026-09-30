'use client';

import { FormEvent, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Loader2, ArrowRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { NexaMark } from './logo';

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage('');
    const result = mode === 'login'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { full_name: name } } });
    setBusy(false);
    if (result.error) return setMessage(result.error.message);
    if (mode === 'signup' && !result.data.session) {
      setMessage('Check your email to confirm your account, then sign in.');
      return;
    }
    window.location.assign('/app');
  }

  return (
    <main className="nexa-shell flex min-h-svh items-center px-5 py-8">
      <section className="w-full">
        <div className="mb-8 flex items-center gap-3">
          <NexaMark />
          <div>
            <div className="text-2xl font-black tracking-tight"><span className="text-white">NEXA</span> <span className="text-violet-400">CODE</span></div>
            <div className="text-sm text-zinc-500">Build. Fix. Ship.</div>
          </div>
        </div>
        <div className="glass rounded-3xl p-5 shadow-[0_18px_70px_rgba(0,0,0,.28)]">
          <div className="mb-6">
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><Sparkles size={19}/></div>
            <h1 className="text-2xl font-semibold">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
            <p className="mt-1 text-sm text-zinc-500">{mode === 'login' ? 'Continue to your coding workspace.' : 'Start your Nexa Code workspace.'}</p>
          </div>
          <form onSubmit={submit} className="space-y-4">
            {mode === 'signup' && <label className="block"><span className="mb-2 block text-sm text-zinc-300">Name</span><input value={name} onChange={e=>setName(e.target.value)} required className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 outline-none transition focus:border-violet-500" placeholder="Your name" /></label>}
            <label className="block"><span className="mb-2 block text-sm text-zinc-300">Email</span><input type="email" value={email} onChange={e=>setEmail(e.target.value)} required className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 outline-none transition focus:border-violet-500" placeholder="you@example.com" /></label>
            <label className="block"><span className="mb-2 block text-sm text-zinc-300">Password</span><input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={6} className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 outline-none transition focus:border-violet-500" placeholder="••••••••" /></label>
            {message && <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm text-violet-200">{message}</div>}
            <button disabled={busy} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 font-semibold text-white shadow-[0_0_24px_rgba(139,92,246,.25)] transition hover:bg-violet-500 disabled:opacity-60">{busy ? <Loader2 className="animate-spin" size={18}/> : <>{mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight size={17}/></>}</button>
          </form>
          <div className="mt-5 text-center text-sm text-zinc-500">{mode === 'login' ? <>New to Nexa? <Link className="text-violet-300 hover:text-violet-200" href="/signup">Create an account</Link></> : <>Already have an account? <Link className="text-violet-300 hover:text-violet-200" href="/login">Sign in</Link></>}</div>
        </div>
      </section>
    </main>
  );
}
