# Task 2: Add checkout customer selection and warranty management UI

Read `docs/superpowers/specs/2026-10-10-parts-warranty-design.md` for binding behavior. Task 1 is complete and provides warranty helpers in `window.Inventory` plus optional `customerId` for `recordSaleBatch`.

Files: modify `index.html`, `app.js`, `style.css`, `navigation.test.js` only. Do not change Supabase migrations in this task.

Requirements:

- Add optional `sale-customer` selector to sales; pass its value as `customerId` into `recordSaleBatch`.
- Add an admin-only item form field for `warrantyMonths`; clerk must not see or change it.
- Add a `warranties` page/tab with keyword search (customer, product, barcode) and filters active, expiring, expired, in_progress.
- Provide manual warranty creation and editing; must use existing validation helpers.
- Provide selected-warranty detail, a repair-case form/list, and update existing cases.
- Clerks can read and create/update warranties/cases but must not see delete controls. Only admins may delete with confirmation.
- Use existing `saveState`, status/form error and rendering patterns.
- Keep existing behavior/pages working, including auth gate and monthly sales.

TDD:

1. Add failing navigation tests for all required markup/control IDs, app integration with warranty helpers/customerId, and role-aware deletion.
2. Run `node --test navigation.test.js` and record the failure.
3. Implement minimal UI/behavior.
4. Run `node --test navigation.test.js`, `node --check app.js`, then `node --test` once.

Write a report to `.superpowers/sdd/2026-10-10-parts-warranty/task-2-report.md` with RED/GREEN evidence, files changed, self-review, and concerns. Do not create subagents. There is no Git repository: do not commit.
