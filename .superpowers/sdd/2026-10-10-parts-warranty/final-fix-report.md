# Final review fix report: automatic warranty creator

## Scope and root cause

The authenticated user is already captured in `app.js` by `bootstrap(user)` as `currentUser`, and manual warranty and repair case creation use `currentUser?.id`. Checkout did not pass that ID to `recordSaleBatch`. The batch sale code created automatic warranties without `createdBy`, so normalization saved an empty creator string.

Changed only `inventory.js`, `inventory.test.js`, `app.js`, and `navigation.test.js`. Existing `recordSaleBatch` callers without `createdBy` remain valid because the new field is optional and warranty normalization already accepts a missing value. No Supabase files or persisted records were changed. The workspace is not a Git repository; no commit was made.

## Changes

- `app.js`: checkout passes `createdBy: currentUser?.id`, using the user captured during authenticated bootstrap.
- `inventory.js`: each automatic warranty receives `createdBy: fields.createdBy` in its stored snapshot.
- `inventory.test.js`: regression test checks a supplied creator survives automatic warranty creation.
- `navigation.test.js`: VM integration test boots the app with a signed-in user, submits checkout, and checks the creator and customer fields sent to `recordSaleBatch`.

## TDD and verification evidence

Before production edits, both new tests failed for the intended reason:

- `node --test --test-name-pattern='preserves the supplied creator' inventory.test.js`: expected `authenticated-user-id`, actual empty string; exit 1.
- `node --test --test-name-pattern='checkout sends the authenticated bootstrap user' navigation.test.js`: expected `authenticated-user-id`, actual `undefined`; exit 1.

After the two production changes:

- `node --test inventory.test.js navigation.test.js`: 63 passed, 0 failed; exit 0.
- `node --check inventory.js`, `node --check app.js`, `node --check inventory.test.js`, and `node --check navigation.test.js`: all exit 0.
- `node --test`: 70 passed, 0 failed; exit 0. This was run once after focused tests and syntax checks.

## Limits

No live browser or Supabase session was exercised. The browser integration test runs the real checkout handler and bootstrap function with in-memory DOM and persistence substitutes; the state regression test runs the real inventory implementation.
