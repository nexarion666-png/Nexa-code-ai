NEXA CODE AI — TWO MODE WORKFLOW PATCH

Files:
- app/components/chat-panel.tsx
- app/api/chat/route.ts

What this changes:
1. Explicit Conversation / Agent mode switch; sending a message no longer automatically changes the selected mode based on words like "fix" or "build".
2. Conversation mode is prompted to discuss/plan and output a complete final prompt ending with [PROPOSAL_READY].
3. A "Send this prompt to Agent" button appears on assistant messages that include [PROPOSAL_READY].
4. Agent mode sends its selected mode to /api/chat and asks the server to load existing project_files (path/content) as bounded context before responding.
5. Agent-mode responses expose the existing Generate Proposal workflow.
6. After a proposal exists, the user can send a truthful proposal-status report back to Conversation Mode.
7. Existing proposal review/approval workflow and per-message Copy buttons are retained.

Important workflow note:
- This preserves Nexa's existing proposal approval flow. Agent creates a proposal; the user must still Review/Apply changes. The status report explicitly says proposed changes have not been applied.
- This is a targeted patch, not a guarantee of error-free generated projects.
- No build/test or Vercel deployment was run as part of creating this ZIP.

Apply:
Extract into the Nexa Code AI repository root, overwriting the two matching files. Run npm run build and test both modes before committing/deploying.
