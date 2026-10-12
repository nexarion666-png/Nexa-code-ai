# Nexa Build Doctor patch

## Implemented
- Added `POST /api/repair-build` for targeted repair proposals from an actual compiler/Vercel build log supplied as `buildLog` (or `errorLog`).
- Authenticates the user and verifies project ownership before reading source or creating proposals.
- Reads the saved `project_files`, extracts failing source paths from the log, and assembles a bounded context including likely type/data files and project config.
- Requests minimal full-file patches, rejects malformed/empty output, rejects unchanged/no-op output, and blocks unsafe paths.
- Persists only changed paths to `proposals` and `file_changes`; it does not overwrite project files before the user reviews/applies the proposal.
- Updated `POST /api/generate-proposal` to return HTTP 422 `PROPOSAL_NO_CHANGES` instead of saving a misleading proposal with zero changes.

## API usage
Send an authenticated JSON POST to `/api/repair-build`:
```json
{
  "projectId": "YOUR_PROJECT_UUID",
  "buildLog": "Paste the full relevant TypeScript/Vercel build error here",
  "provider": "groq"
}
```
`provider` is optional. The response contains `proposalId`, `changesCount`, and `changedPaths`; review/apply the proposal through the existing workflow.

## Important boundaries
This patch does not independently poll Vercel deployment logs or execute a new production build. The caller must supply the actual log, then apply the reviewed proposal and trigger a fresh build/deploy. Autonomous fetch-log/build/retry requires a separately authenticated worker/CI job and durable job state; a single Next.js request is not a reliable background worker. No build/deployment has been claimed as verified by this patch.

## Validation
Run `npm ci` and `npm run build` from the repository root, then test with a real failed build log. Confirm a no-op response is rejected and a valid repair creates a pending proposal with nonzero `file_changes`.
