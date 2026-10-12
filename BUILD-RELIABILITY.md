# Nexa Code AI — Build Reliability Layer

This update adds static build preflight and deployment-log diagnostics to the existing NCA project.

## What it does

- Runs cross-file TypeScript checking during generated proposal validation, in addition to TS/JS/JSX syntax checks.
- Uses focused AI repair attempts when generated proposal validation detects a problem; it asks the model to repair the underlying type contract rather than suppress errors.
- Adds `POST /api/validate-build`, which checks the authenticated user's project before deployment.
- Runs the same preflight inside the Vercel deployment endpoint, so invalid project paths, missing Next.js shell files, malformed JSON, missing local imports, obvious undeclared dependencies, syntax errors, and detected cross-file type errors block deployment submission.
- Adds `GET /api/deploy/vercel/logs`, which retrieves the latest deployment's build logs through Vercel's deployment-events API.
- When Vercel confirms a build failure, Nexa can use those logs to prepare a targeted AI repair proposal. The repair is statically validated and saved as a pending proposal; it is **not applied automatically**. The user must review and approve the changes. Existing pending proposals are reused to avoid duplicate repair proposals.
- Shows a separate “Run Static Build Checks” action and includes relevant Vercel log lines in the deployment error message when available.
- Adds `npm run test:build-validation`, a small regression suite for valid projects, missing cross-file properties, unsafe paths, malformed JSON, and undeclared dependencies.

## Important limits

Static preflight is not a real production build. It deliberately does not install or execute untrusted generated project code inside NCA's Vercel API function. Type resolution uses a virtual TypeScript program and NCA's installed package tree as a best-effort check; a generated project's own lockfile and dependency versions may differ.

The actual Vercel build remains authoritative. External service outages, missing environment variables, unsupported runtime behavior, platform changes, and dependency registry failures can still cause a deployment to fail. The UI only reports a deployment as successful after Vercel returns `READY`.

A fully isolated pre-deployment `npm ci && npm run build` requires a separate sandbox/build-runner service or a CI workflow. It must not be implemented by executing arbitrary generated project code in the NCA serverless function.

## Verification status

The lightweight regression suite passed in this environment using the globally available TypeScript compiler. The package manager installation timed out, so a full `npm ci` and `npm run build` could not be completed here. Do not treat this ZIP as production-build-verified until the NCA app itself passes its production build in CI/Vercel and the new endpoints are tested against a real Supabase project, AI provider key, and Vercel token.
