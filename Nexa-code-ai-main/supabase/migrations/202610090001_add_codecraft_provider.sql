-- Add CodeCraft API as a supported BYOK provider for existing installations.
alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;

alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('codecraft', 'gemini', 'groq', 'openrouter'));
