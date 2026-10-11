Nexa Code AI targeted patch
==========================

Files included:
- lib/project-completeness.ts
  Local import validation now resolves against both proposal files and existing project files, avoiding false missing-module errors for dependencies already saved in the project.
- app/api/generate-proposal/route.ts
  Proposal validation receives existing project files; the repair agent also receives existing files as context when diagnosing a missing import.
- app/components/chat-panel.tsx
  Adds a compact Copy button to each user and Nexa message, copies the full message text, shows brief Copied feedback, and has a clipboard fallback.

Apply:
1. Back up the current repository.
2. Extract this ZIP into the repository root, preserving folders and allowing these three files to be replaced.
3. Run `npm run build` and test a proposal that imports a file already present in the project, a proposal that needs a new local module, and copy buttons on both user and assistant messages.
4. Commit and deploy only after checks pass.

This patch has not been built or deployed in this environment because dependencies are not installed here.
