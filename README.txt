Nexa Code AI: project shell validation fix

Contains only two modified source files:
- lib/project-completeness.ts
- app/api/generate-proposal/route.ts

Changes:
- Completeness validation now checks existing Supabase project files together with proposal files for package.json, homepage, and App Router layout.
- Repair requests for missing shell files ask for the complete set of missing shell files in one response, avoiding sequential package.json -> homepage failures.

Apply by replacing only these two files in the existing repository. Run npm run build before deploying.
This patch has not been build-tested in the full project.
