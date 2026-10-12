# Final review fix: preserve automatic warranty creator

Final review found that automatic warranties omit the required creator field.

Modify only `inventory.js`, `inventory.test.js`, `app.js`, and `navigation.test.js` as necessary.

- Extend `recordSaleBatch(state, { lines, customerId, createdBy })` with optional `createdBy`.
- Every automatic warranty must store that `createdBy` snapshot. Existing callers without it stay compatible.
- The sale checkout handler must pass the authenticated current user ID. Capture the signed-in user during bootstrap, not from mutable DOM text.
- Add a state regression test showing a supplied creator is preserved on automatic warranty creation.
- Add/update a browser structure/integration test showing checkout passes the current authenticated creator to `recordSaleBatch`.
- Run focused tests, syntax checks, then complete `node --test` once.

Use `apply_patch`, do not dispatch subagents, and write a report to `.superpowers/sdd/2026-10-10-parts-warranty/final-fix-report.md`. This is a non-Git workspace; do not commit.
