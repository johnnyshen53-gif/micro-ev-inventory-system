# Task 1 report: warranty state and business rules

## Status

Implemented Task 1 in `inventory.js` and `inventory.test.js`. No Git repository exists in this workspace, so no commit was made.

## RED / GREEN

- RED command: `node --test inventory.test.js` after adding the initial tests. Result: 32 tests, 23 passed, 9 failed. Failures showed missing `warrantyMonths`, missing warranty state collections, missing warranty APIs, and no checkout-generated warranties.
- GREEN command: `node --test inventory.test.js`. Result: 32 passed, 0 failed.
- Added an explicit leap-year January 31 → February 29 calendar-expiry regression check during self-review.
- Final focused command: `node --test inventory.test.js`. Result: 33 passed, 0 failed.
- Final suite command: `node --test`. Result: 60 passed, 0 failed.

## Changed files

- `inventory.js`: normalizes `warrantyMonths` and legacy state; validates warranty and case records; adds create, update, delete, and filter functions; creates sale-linked warranties only after stock validation in `recordSaleBatch`.
- `inventory.test.js`: covers defaults and validation, old backups, manual records and snapshots, case statuses and edits, filters, multi-line checkout, no-customer checkout, failed checkout, and month-end expiry.

## Self-review

- Checked callers and exports in the task files. Existing `recordSaleBatch` callers remain valid because `customerId` is optional. All new APIs are exported on `window.Inventory`.
- Existing backups gain `warrantyMonths: 0`, `warranties: []`, and `warrantyCases: []` on load; old sales never create historical warranties.
- Warranty and case snapshots are saved separately from current item data. Deleting a warranty removes its cases in the same returned state. Invalid dates, references at creation, statuses, and duplicate IDs are rejected.
- Sale stock is validated before warranty generation. A failed checkout does not modify the source state.
- No UI, role authorization, Supabase RLS, or database work was changed; those are outside Task 1. Caller code must enforce the role restrictions in the design. The purchase date uses the sale timestamp's UTC date, matching the existing ISO sale timestamp convention; this can differ from the Taipei calendar date near midnight.

## Fix round: Taipei calendar date

- Review issue: UTC date extraction used by automatic `purchasedAt` and the default `warrantiesForFilter` date could show the previous day at Taipei 00:30. The prior self-review warning above is resolved by this round.
- RED: added a frozen-clock test at `2026-10-09T16:30:00.000Z` (Taipei 2026-10-10 00:30). `node --test inventory.test.js` reported 34 tests, 33 passed, 1 failed: actual automatic purchase date `2026-10-09` versus expected `2026-10-10`.
- Fix: one `taipeiDate` helper uses `Intl.DateTimeFormat` with `Asia/Taipei` for automatic purchase date, its calendar-month expiry input, and the default filter date. The sale's ISO `createdAt` remains unchanged.
- GREEN: `node --test inventory.test.js` passed 34/34; `node --test` passed 61/61.
- Files changed in this round: `inventory.js`, `inventory.test.js`, and this report. No Git repository exists, so no commit was made.
