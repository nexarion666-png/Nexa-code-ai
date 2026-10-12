'use client';

import { useState } from 'react';
import { X, FolderPlus, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function ProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  if (!open) return null;

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    setPending(true);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        alert('Please sign in before creating a project.');
        return;
      }

      const { data, error } = await supabase
        .from('projects')
        .insert({ name: trimmedName, user_id: user.id, files: {} })
        .select()
        .single();

      if (error) {
        alert(error.message);
        return;
      }

      onClose();
      setName('');
      router.push(`/app/${data.id}`);
      router.refresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to create project.');
    } finally {
      setPending(false);
    }
  }

  return <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 px-4 backdrop-blur-sm" onMouseDown={onClose}>
    <div className="w-full max-w-[370px] rounded-3xl border border-zinc-800 bg-[#121214] p-5 shadow-2xl" onMouseDown={e => e.stopPropagation()}>
      <div className="mb-5 flex items-center justify-between"><div><h2 className="text-lg font-semibold">New project</h2><p className="text-sm text-zinc-500">Create a workspace for your code.</p></div><button type="button" onClick={onClose} className="rounded-xl p-2 text-zinc-400 hover:bg-zinc-800"><X size={18}/></button></div>
      <form onSubmit={handleCreate} className="space-y-4">
        <label className="block"><span className="mb-2 block text-sm text-zinc-300">Project name</span><input autoFocus value={name} onChange={event => setName(event.target.value)} required maxLength={80} placeholder="Image test" className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 outline-none focus:border-violet-500" /></label>
        <button type="submit" disabled={pending || !name.trim()} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 font-semibold disabled:opacity-60">{pending ? <Loader2 size={18} className="animate-spin"/> : <FolderPlus size={18}/>} {pending ? 'Creating…' : 'Create project'}</button>
      </form>
    </div>
  </div>;
}
