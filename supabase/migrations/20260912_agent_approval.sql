alter table agent_runs
  drop constraint if exists agent_runs_status_check;

alter table agent_runs
  add constraint agent_runs_status_check
  check (
    status in (
      'pending',
      'running',
      'completed',
      'failed',
      'rejected'
    )
  );

alter table agent_runs
  add column if not exists approved_at timestamptz;

alter table agent_runs
  add column if not exists chat_id uuid references chats(id) on delete cascade;

alter table agent_actions
  add column if not exists memory_type text
  check (memory_type in ('decision', 'context', 'preference'));

create index if not exists agent_runs_chat_created_idx
  on agent_runs(chat_id, created_at desc);
