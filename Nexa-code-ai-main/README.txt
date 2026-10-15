NEXA CODE AI — PROJECT VALIDATION + VERCEL BUILD VERIFICATION PATCH

Files included (copy to the same paths in your EXISTING Nexa repository):
- app/api/generate-proposal/route.ts
- app/api/deploy/vercel/route.ts
- app/api/deploy/vercel/status/route.ts (new)
- app/components/ToolsPanel.tsx

WHAT THIS PATCH DOES
1. Before a proposal is saved, it parses generated TS/TSX with the TypeScript compiler API and detects syntax errors such as malformed JSX. A detected syntax error is sent into Nexa's existing bounded, focused repair pass; the corrected file is checked again before proposal creation.
2. The existing project-completeness and local-import checks remain in the proposal path.
3. Deployment records default to QUEUED rather than falsely defaulting to READY.
4. Deploy Now polls Vercel's actual deployment state. It reports READY only when Vercel returns READY, reports ERROR/CANCELED explicitly, and never treats a submitted deployment as a successful build.

IMPORTANT LIMITATIONS
- This does not guarantee every project will build. Type checking, dependency installation, environment variables, and runtime behavior still need real deployment validation.
- This patch does not yet automatically retrieve Vercel build logs, ask the AI to repair arbitrary build/type errors, and redeploy after a failed Vercel build. It catches TS/TSX syntax errors before proposal creation and verifies the actual Vercel result; a full post-deployment log-driven repair/redeploy orchestrator remains additional work.
- Run npm run build on Nexa itself before deployment. The changed files passed TypeScript transpile/syntax checks in this environment, but a full Next.js build was not verified because dependency installation did not finish here.

Apply only these four files. Do not copy any nested duplicate project folders from previous ZIPs.
