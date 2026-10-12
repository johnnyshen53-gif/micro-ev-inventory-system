# Task 1: Extend the state model and warranty business rules

Read `docs/superpowers/specs/2026-10-10-parts-warranty-design.md` for binding behavior.

Files: modify `inventory.js` and `inventory.test.js`.

Interfaces to produce: `createWarranty`, `updateWarranty`, `deleteWarranty`, `addWarrantyCase`, `updateWarrantyCase`, `deleteWarrantyCase`, `warrantiesForFilter`, plus `recordSaleBatch(state, { lines, customerId })` with optional customer ID.

Requirements:

- `warrantyMonths` is a non-negative integer; `0` means no warranty.
- Older backups load with `warrantyMonths: 0`, empty `warranties`, and empty `warrantyCases`; never create historical warranties.
- Snapshot warranty item name, barcode, purchase date, and expiry date; later item edits must not alter snapshots.
- Repair-case statuses are only `pending`, `in_progress`, `completed`, `not_covered`.
- Use calendar-month expiry addition, including month-end cases, not fixed days.
- `recordSaleBatch` creates a warranty for each eligible sale line only when `customerId` is supplied. No customer remains a valid sale and creates no warranty.
- Warranty creation must happen only after stock validation, so failed sales make no warranties.

TDD:

1. Add failing tests for default/validation, calendar expiry, manual warranty validation, case statuses, old backup normalization, multi-line eligible sales, and no-customer sales.
2. Run `node --test inventory.test.js` and record the failure.
3. Implement the smallest behavior passing those tests.
4. Run `node --test inventory.test.js`, then `node --test` once.

Write a report to `.superpowers/sdd/2026-10-10-parts-warranty/task-1-report.md` including RED/GREEN commands and output summary, modified files, and self-review. Do not create subagents. There is no Git repository: do not commit and say so in the report.
