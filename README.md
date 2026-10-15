# Nexa Code AI — Final MVP

Phases 1–6: UI, Supabase auth/projects, BYOK 3-key failover, conversation mode, proposals/file apply, live preview, GitHub, Vercel deploy, sharing, and PWA install flow.

## Setup
1. `npm install`
2. Configure `.env.local` from `.env.example` including `KEY_ENCRYPTION_SECRET`.
3. Run `supabase/schema.sql` in the Supabase SQL editor.
4. `npm run build`


## AI provider priority

In **AI Settings → Provider priority**, move Clean APIs, Gemini, Groq, and OpenRouter into the order you want Nexa to try. The saved order is applied server-side to chat, proposal generation, and repair-provider fallback. Apply `supabase/migrations/202610150001_add_ai_provider_preferences.sql` in an existing Supabase project; fresh installations can use the updated `supabase/schema.sql`.

## Verification note

Run `npm run test:all-validation` for the generated-code syntax/type-validation and file-block parsing regression tests. A full `npm run build` still requires installing project dependencies and validating the app in your deployment environment. The current preview route is still a lightweight browser preview of the page component, not an isolated execution of the complete Next.js project; it does not yet resolve all project imports/dependencies or run a production build in a sandbox.
