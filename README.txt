Nexa Code AI — CodeCraft Cloudflare response fix

Changed files only:
- failover.ts
- lib/ai/failover.ts

What changed:
- Both CodeCraft chat-completions URLs now use https://www.codecraftapi.com/v1/chat/completions.
- CodeCraft responses with text/html are detected and reported as an endpoint/security-challenge error instead of being treated as a successful empty model response.
- HTML errors from other providers are summarized rather than copied into the error message.

Apply to your existing repository:
1. Extract the ZIP.
2. Copy both files to the same paths in the repository root:
   - failover.ts -> <repo>/failover.ts
   - lib/ai/failover.ts -> <repo>/lib/ai/failover.ts
3. Commit and push to main so Vercel rebuilds.

Important:
This patch does not bypass Cloudflare. If the www hostname also returns a Cloudflare challenge, CodeCraft must fix or permit API access from server-side requests. Use the configured Gemini/Groq/OpenRouter fallback providers while that is resolved.
No full production build or live API request was run for this patch.
