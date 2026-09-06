# Nexa Code AI — Google OAuth PKCE fix

This patch fixes the Google OAuth callback by completing the PKCE code exchange in the browser Supabase client.

IMPORTANT: the old server callback route must be removed because `/auth/callback` is now a client page.

Before committing, run:

```bash
rm -f app/auth/callback/route.ts
rm -f app/auth/callback/page.tsx
cp -r ../nexa-code-ai-google-oauth-fix/. .
grep -n "baseUrl" tsconfig.json || echo "baseUrl removed"
find app/auth/callback -maxdepth 1 -type f -print
```

The callback directory must contain ONLY:

```text
app/auth/callback/page.tsx
```

Then:

```bash
git add -A
git commit -m "fix: resolve OAuth callback route conflict"
git push origin main
```


## v0.8 additions
- Project ZIP download endpoint and Download ZIP action.
- Individual current-file download action.
- Mobile GitHub push/reconnect action using the existing server-side GitHub connection.
- Installable PWA manifest, service worker, icons, and install prompt.
