create table if not exists public.user_ai_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider_order text[] not null default array['cleanapis','gemini','groq','openrouter']::text[],
  updated_at timestamptz not null default now(),
  constraint user_ai_preferences_provider_order_valid check (
    provider_order <@ array['cleanapis','gemini','groq','openrouter']::text[]
  )
);

alter table public.user_ai_preferences enable row level security;
drop policy if exists "Users can read own AI preferences" on public.user_ai_preferences;
drop policy if exists "Users can insert own AI preferences" on public.user_ai_preferences;
drop policy if exists "Users can update own AI preferences" on public.user_ai_preferences;
create policy "Users can read own AI preferences" on public.user_ai_preferences for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own AI preferences" on public.user_ai_preferences for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own AI preferences" on public.user_ai_preferences for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
