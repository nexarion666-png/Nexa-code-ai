create extension if not exists "pgcrypto";

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

alter table public.projects add column if not exists files jsonb not null default '{}'::jsonb;

alter table public.projects enable row level security;
drop policy if exists "Users can view own projects" on public.projects;
drop policy if exists "Users can create own projects" on public.projects;
drop policy if exists "Users can delete own projects" on public.projects;
create policy "Users can view own projects" on public.projects for select to authenticated using (auth.uid() = user_id);
create policy "Users can create own projects" on public.projects for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can delete own projects" on public.projects for delete to authenticated using (auth.uid() = user_id);
create index if not exists projects_user_id_created_at_idx on public.projects(user_id, created_at desc);

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gemini','groq','openrouter')),
  key_name text not null check (key_name in ('Key 1','Key 2','Key 3')),
  api_key text not null,
  created_at timestamptz not null default now(),
  unique(user_id, provider, key_name)
);
alter table public.user_api_keys enable row level security;
drop policy if exists "Users can view own API keys" on public.user_api_keys;
drop policy if exists "Users can insert own API keys" on public.user_api_keys;
drop policy if exists "Users can update own API keys" on public.user_api_keys;
drop policy if exists "Users can delete own API keys" on public.user_api_keys;
create policy "Users can view own API keys" on public.user_api_keys for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own API keys" on public.user_api_keys for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own API keys" on public.user_api_keys for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own API keys" on public.user_api_keys for delete to authenticated using (auth.uid() = user_id);
create index if not exists user_api_keys_user_provider_idx on public.user_api_keys(user_id, provider);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
alter table public.messages enable row level security;
drop policy if exists "Users can view own project messages" on public.messages;
drop policy if exists "Users can insert own project messages" on public.messages;
create policy "Users can view own project messages" on public.messages for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own project messages" on public.messages for insert to authenticated with check (auth.uid() = user_id);
create index if not exists messages_project_created_at_idx on public.messages(project_id, created_at);

-- Phase 3: proposals, project files, and file changes
create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  content text,
  status text default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  path text not null,
  content text,
  updated_at timestamptz not null default now(),
  unique(project_id, path)
);

create table if not exists public.file_changes (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid references public.proposals(id) on delete cascade,
  path text not null,
  operation text check (operation in ('create','update','delete')),
  old_content text,
  new_content text
);

alter table public.proposals enable row level security;
alter table public.project_files enable row level security;
alter table public.file_changes enable row level security;

drop policy if exists "user can manage own proposals" on public.proposals;
drop policy if exists "user can manage own files" on public.project_files;
drop policy if exists "user can manage file changes" on public.file_changes;
create policy "user can manage own proposals" on public.proposals for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "user can manage own files" on public.project_files for all to authenticated using (exists (select 1 from public.projects where projects.id = project_files.project_id and projects.user_id = auth.uid())) with check (exists (select 1 from public.projects where projects.id = project_files.project_id and projects.user_id = auth.uid()));
create policy "user can manage file changes" on public.file_changes for all to authenticated using (exists (select 1 from public.proposals where proposals.id = file_changes.proposal_id and proposals.user_id = auth.uid())) with check (exists (select 1 from public.proposals where proposals.id = file_changes.proposal_id and proposals.user_id = auth.uid()));

create index if not exists proposals_project_created_at_idx on public.proposals(project_id, created_at desc);
create index if not exists project_files_project_path_idx on public.project_files(project_id, path);
create index if not exists file_changes_proposal_idx on public.file_changes(proposal_id);

-- Phase 5: monetization, usage, and public sharing
alter table public.projects add column if not exists is_public boolean not null default false;
create index if not exists projects_public_idx on public.projects(is_public);

drop policy if exists "Users can update own projects" on public.projects;
create policy "Users can update own projects" on public.projects for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Anyone can view public projects" on public.projects;
create policy "Anyone can view public projects" on public.projects for select to anon, authenticated using (is_public = true);

drop policy if exists "Anyone can view files in public projects" on public.project_files;
create policy "Anyone can view files in public projects" on public.project_files for select to anon, authenticated using (
  exists (select 1 from public.projects where projects.id = project_files.project_id and projects.is_public = true)
);

create table if not exists public.user_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  message_count integer not null default 0 check (message_count >= 0),
  proposal_count integer not null default 0 check (proposal_count >= 0),
  date date not null default current_date,
  primary key (user_id, date)
);

alter table public.user_usage enable row level security;
drop policy if exists "Users can view own usage" on public.user_usage;
drop policy if exists "Users can insert own usage" on public.user_usage;
drop policy if exists "Users can update own usage" on public.user_usage;
create policy "Users can view own usage" on public.user_usage for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own usage" on public.user_usage for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own usage" on public.user_usage for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists user_usage_date_idx on public.user_usage(user_id, date desc);


-- Phase 5: GitHub integration
alter table public.projects add column if not exists github_repo_url text;
alter table public.projects add column if not exists github_repo_name text;

create table if not exists public.user_github_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token text,
  username text,
  created_at timestamptz not null default now()
);

alter table public.user_github_tokens enable row level security;
drop policy if exists "Users can view own GitHub connection" on public.user_github_tokens;
drop policy if exists "Users can insert own GitHub connection" on public.user_github_tokens;
drop policy if exists "Users can update own GitHub connection" on public.user_github_tokens;
drop policy if exists "Users can delete own GitHub connection" on public.user_github_tokens;
create policy "Users can view own GitHub connection" on public.user_github_tokens for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own GitHub connection" on public.user_github_tokens for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own GitHub connection" on public.user_github_tokens for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own GitHub connection" on public.user_github_tokens for delete to authenticated using (auth.uid() = user_id);

-- Phase 6: Vercel deployments
create table if not exists public.deployments (
  id uuid primary key default gen_random_uuid(), project_id uuid references public.projects(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade, url text, status text default 'READY',
  vercel_deployment_id text, created_at timestamptz not null default now()
);
alter table public.user_github_tokens add column if not exists vercel_token text;
alter table public.deployments enable row level security;
drop policy if exists "Users can view own deployments" on public.deployments;
drop policy if exists "Users can insert own deployments" on public.deployments;
create policy "Users can view own deployments" on public.deployments for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own deployments" on public.deployments for insert to authenticated with check (auth.uid() = user_id);
create index if not exists deployments_project_created_idx on public.deployments(project_id, created_at desc);
