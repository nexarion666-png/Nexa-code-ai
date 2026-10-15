NEXA CODE AI — PROPOSAL TIMEOUT / MISSING IMPORT PATCH

This is a minimal patch for the existing Nexa Code AI project. It contains only three modified source files:
- app/api/generate-proposal/route.ts
- lib/ai/failover.ts
- lib/project-completeness.ts

Apply by copying these three files into the same paths in your repository. Do not replace the entire repository with this patch ZIP.

Changes:
1. A missing @/ import repair now identifies and references the implied module path, and asks the model to create only the real missing component/module instead of regenerating unrelated files.
2. Proposal validation repair is bounded to two passes rather than four.
3. Truncated generation output is passed to file-block validation/targeted repair instead of automatically spending up to two additional full-generation continuation calls.
4. Repair-mode provider fallback tests only the first configured model per provider, avoiding repeated slow model variants for the same small repair.
5. Completeness validation recognizes the existing project's package, homepage, and App Router layout when a proposal changes only a subset of files.

Important:
- This patch is based on the latest uploaded ZIP available in this conversation.
- It has not been run through npm run build or deployed to Vercel in this environment. Run npm run build before deploying.
- It reduces unnecessary provider work, but provider latency and Vercel plan/runtime limits can still affect long generations.
