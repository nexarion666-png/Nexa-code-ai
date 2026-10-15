-- Retire credentials for providers no longer supported by this application.
-- Never reinterpret old provider credentials as Clean APIs credentials.
delete from public.user_api_keys
where provider not in ('cleanapis', 'gemini', 'groq', 'openrouter');

alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;

alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('cleanapis', 'gemini', 'groq', 'openrouter'));
