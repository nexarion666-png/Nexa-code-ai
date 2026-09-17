alter table agent_runs
  drop constraint if exists agent_runs_status_check;

alter table agent_runs
  add constraint agent_runs_status_check
  check (
    status in (
      'pending',
      'running',
      'verifying',
      'repairing',
      'completed',
      'failed',
      'rejected',
      'stale'
    )
  );

alter table agent_runs
  add column if not exists repair_attempts integer not null default 0;

alter table agent_runs
  add column if not exists verification jsonb;