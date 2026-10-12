# SDD ledger — plan: docs/superpowers/plans/2026-10-09-offline-quotation-and-customers.md

Ruling: The workspace is not a Git repository, so task commits and worktree isolation are unavailable; all changes remain in the user-provided workspace and verification evidence is recorded here — cost if wrong: changes cannot be separated by commit.
Pre-flight: Task 1 produces the `State` structure and APIs consumed by Tasks 2–4; Task 2 and Task 3 both extend `app.js` but use page-specific element guards; Task 4 consumes Task 1 backup validation and Tasks 2–3 DOM flows.
