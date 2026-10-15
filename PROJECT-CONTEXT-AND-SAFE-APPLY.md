# Project context and safe Apply improvements

This patch keeps Nexa's existing Next.js/Supabase architecture and adds three focused improvements:

1. `lib/project-context.ts` ranks saved project files against the current request and includes a bounded set of relevant files in Agent chat and proposal-generation prompts.
2. Proposal instructions now choose scope based on the request: minimal edits for small changes, broader file sets for genuinely new/broad features, and no repetition of unchanged files.
3. `/api/apply-proposal` checks every proposed file against its recorded `old_content` before writing any changes. If the project changed after proposal generation, it returns HTTP 409 with `code: PROPOSAL_STALE` and the conflicting paths rather than silently overwriting them.

## Important limitations

- File retrieval is currently heuristic (request terms, paths, and content matches); it is not yet a recursive import-graph resolver. If a needed file was omitted from the context window, the model is instructed not to invent its contents, but a future iteration should add import tracing and targeted second-pass retrieval.
- The stale-proposal check prevents known stale edits, but the read-check-write sequence is not a database transaction. For full atomicity under concurrent requests, move the check and writes into a PostgreSQL RPC/transaction with row locking or version columns.
- The existing tests for build validation and file-block parsing pass. A full Next.js build could not be run in this environment because dependencies could not be installed before timeout.
