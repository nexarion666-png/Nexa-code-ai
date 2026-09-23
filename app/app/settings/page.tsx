import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { SettingsClient } from '@/app/components/settings-client';
import { GitHubSettings } from '@/app/components/github-settings';
import { VercelSettings } from '@/app/components/vercel-settings';

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from('user_api_keys').select('provider,key_name').eq('user_id', user.id);
  const { data: github } = await supabase.from('user_github_tokens').select('username').eq('user_id', user.id).maybeSingle();
  return <main className="nexa-shell min-h-svh px-3 pb-8 pt-4">
    <div className="mb-5 flex items-center gap-3"><Link href="/app" className="grid h-11 w-11 place-items-center rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-200"><ArrowLeft size={20}/></Link><div><h1 className="text-lg font-bold">AI Settings</h1><p className="text-xs text-zinc-500">Manage your BYOK provider keys</p></div></div>
    <GitHubSettings initialUsername={github?.username ?? null}/><div className="mt-4"><VercelSettings/></div><div className="mt-4"><SettingsClient initialKeys={data ?? []}/></div>
  </main>;
}
