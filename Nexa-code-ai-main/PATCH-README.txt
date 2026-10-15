NEXA CODE AI — AGENT BUILDS WITHOUT A GENERATE PROPOSAL BUTTON

Apply this patch to the root of the Nexa Code AI repository.

Changes:
- Removes the visible "Generate Proposal" button.
- Conversation Mode remains discussion/planning and does not generate file changes.
- Sending a message while Agent Mode is selected automatically invokes the existing validated file-change generation pipeline after the chat response finishes.
- Shows an "Agent is building, editing, or fixing your project…" progress state.
- Keeps Review Changes and Apply Changes as explicit safety steps.
- Sends the complete latest chat turn to the generation endpoint rather than using stale React state.

Apply:
1. Back up the repository.
2. Extract this ZIP into the repository root, replacing app/components/chat-panel.tsx.
3. Run npm run build.
4. Test Conversation mode: no file changes should be generated.
5. Test Agent mode: send a build/edit/fix task; it should automatically prepare changes and show Review Changes when ready.
6. If the build fails, do not deploy; share the exact error.

Note: The internal API route /api/generate-proposal remains as an implementation detail; the user-facing button and manual step are removed. Review/Apply are intentionally retained.
