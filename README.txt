Nexa Code AI — root failover.ts patch

Fixes the Vercel TypeScript error at ./failover.ts:337 by including CodeCraft in the Provider union and provider maps.

Apply this file to the ROOT of the existing Nexa Code AI repository, replacing the existing root-level failover.ts.
Do NOT place it in lib/ai/.

This is a changed-file patch, not a full project ZIP. The patch has not been validated with a full production build against the live main branch.
