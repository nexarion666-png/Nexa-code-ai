Nexa Code AI — Clean APIs provider replacement patch

This patch removes the retired primary provider from Nexa's active configuration and sets Clean APIs as the primary OpenAI-compatible streaming provider.

Clean APIs:
- Base URL: https://cleanapis.com/v1
- Chat completions: https://cleanapis.com/v1/chat/completions
- Initial model order: gemini-3.7-flash, deepseek-v4-flash-0731, claude-sonnet-5
- API keys use Nexa's existing encrypted BYOK mechanism.
- Gemini direct API, Groq, and OpenRouter remain available as fallbacks.

Apply:
1. Copy each file from this patch over the same path in your repository.
2. Delete the obsolete migration listed in DELETE_FILES.txt.
3. Run supabase/migrations/202610110001_replace_primary_provider.sql in Supabase SQL Editor for an existing database. This removes credentials for unsupported providers and updates the provider constraint; it does not turn old credentials into Clean APIs keys.
4. Add your Clean APIs key under Settings → AI Keys, save it, and use Test.
5. Push to main and verify the Vercel deployment and a chat request.

The user confirmed the Clean APIs models endpoint and streaming work from Termux. This patch has not been built or deployed to Vercel, so verify the deployed integration before relying on it.
