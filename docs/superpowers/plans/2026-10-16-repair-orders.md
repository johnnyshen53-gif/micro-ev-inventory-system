# Repair Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not delegate unless the user explicitly requests it.

**Goal:** Add cloud-backed paid repair orders with quotation, atomic parts/battery consumption, battery warranty, full payment, search, and printing.

**Architecture:** Keep repair records separate from sales and free warranty claims. Use Supabase tables with RLS for reads and guarded SQL RPCs for writes; completion is one database transaction. Extend existing inventory serial and warranty models only where a paid repair must be represented truthfully.

**Tech Stack:** Existing vanilla HTML/CSS/JavaScript, Supabase Postgres/RPC, Node test runner, local PGlite SQL tests. No new production dependency.

**Spec:** `docs/superpowers/specs/2026-10-16-repair-orders-design.md`

## Global Constraints

- Only active staff may see or modify repair orders; anonymous users may not read customer contact data.
- Desktop navigation only; existing mobile-only monthly-sales rule stays unchanged.
- Status: intake → quoted → completed, with cancellation only before completion. Payment: unpaid → paid only after completion; no partial payments or refunds.
- Only completion deducts actual parts; battery consumption requires specific in-stock serial IDs. Failed completion leaves order, stock, serials, and warranties unchanged.
- Battery repair warranty requires an explicitly selected customer and positive item warranty months; do not silently create a member or pretend the repair is a sale.
- Repair amounts never enter `sales` or salesperson performance. Free warranty replacement keeps its existing path.
- Do not apply migrations to formal Supabase, Commit, Push, or deploy without the user's explicit approval at the relevant stage. Preserve unrelated worktree changes.

## File Map

- `supabase/migrations/<CLI-generated>_repair_orders.sql`: repair tables, RLS, draft/quote/cancel/payment RPCs. Generate name via `supabase migration new repair_orders` at implementation time.
- `supabase/migrations/<CLI-generated>_complete_repair.sql`: serial/warranty relation extensions and atomic completion RPC. Generate via CLI, not a hand-invented timestamp.
- `supabase/tests/repair_orders.test.sql`, `supabase/tests/run-repair-local.mjs`: SQL behavior and permission tests against the migration chain; runner follows existing monthly-salesperson PGlite pattern.
- `inventory.js`, `inventory.test.js`, `cloud-data.js`, `cloud-data.test.js`: accept and map truthful repair-used serials and repair-origin warranties; expose repair RPCs without putting orders into the generic inventory snapshot.
- `index.html`, `app.js`, `style.css`, `navigation.test.js`, `repair-ui.test.js`: repair page, desktop navigation, safe form/detail behavior, print-only layout and UI tests.

## Review Focus

1. Concurrent completion of the same repair or last in-stock unit: exactly one succeeds and stock never goes negative — Task 2 test.
2. A battery serial from a different item, already used, or repeated twice: completion fails with no partial writes — Task 2 test.
3. Guest repair later changed to a member before battery completion: warranty links the explicitly selected member, never a guessed account — Tasks 1–2 tests.
4. Stale editor saves after another employee completed/cancelled the order: save is rejected rather than reopening or overwriting the completed order — Task 1 test.
5. Logout while a repair request or print view is loading: no prior customer's details appear in the next session — Task 3 test.

---

### Task 1: Repair drafts, quotation, cancellation and full-payment rules

**Files:** Create first migration, SQL tests and local runner named in File Map.

**Interfaces:** `public.save_repair_order(p_order jsonb, p_lines jsonb, p_expected_updated_at timestamptz default null) returns uuid`; `public.cancel_repair_order(p_order_id uuid) returns uuid`; `public.mark_repair_paid(p_order_id uuid) returns uuid`. Read `public.repair_orders` and `public.repair_lines` under active-staff RLS.

- [ ] Write failing SQL tests: assert unique auto number, either member or guest name/phone, at least plate or original serial, nonnegative labor and line price, positive quantities, server-calculated total, intake/quoted transitions, cancellation only before completion, payment only after completion, active-staff access, anonymous denial, and stale `updated_at` rejection.
- [ ] Run `PGLITE_MODULE=/tmp/microev-pglite.nFL0ZN/node_modules/@electric-sql/pglite/dist/index.js node supabase/tests/run-repair-local.mjs` in this workspace; expect the new SQL tests to fail before migration. If that temporary module is gone, install a pinned local PGlite test dependency and point `PGLITE_MODULE` to its `dist/index.js`.
- [ ] Generate the migration with `supabase migration new repair_orders`; implement tables, constraints, index for number/search, RLS, grants and guarded invoker RPCs. Use a database-generated unique `R-YYYYMMDD-####` number in Asia/Taipei; do not trust browser totals or creator IDs.
- [ ] Re-run the local SQL runner; expect all Task 1 tests to pass. Confirm cancellation and payment record actor/time, and editing completed/cancelled orders cannot restore them.

### Task 2: Atomic completion, battery serials and warranty integration

**Files:** Create second migration; modify `supabase/tests/repair_orders.test.sql`, `inventory.js`, `inventory.test.js`, `cloud-data.js`, `cloud-data.test.js`.

**Interfaces:** `public.complete_repair_order(p_order_id uuid, p_serial_ids_by_line jsonb) returns uuid`. Input maps each battery line ID to an array of inventory serial UUIDs; output is the completed repair order ID. Existing stock and serial reads remain through `AppData.loadSnapshot()`.

- [ ] Write failing SQL tests for simultaneous/double completion, insufficient stock, quantity/serial mismatch, wrong-item/used/duplicate serial, guest battery without member, zero battery warranty months, successful mixed parts+battery completion, and rollback after any failure. Assert no row appears in `sales` or salesperson attribution.
- [ ] Write failing `inventory.test.js` and `cloud-data.test.js` cases: `repair_used` serial plus `repair` warranty validates and maps correctly; unrelated sale/warranty paths still validate.
- [ ] Run the targeted SQL and Node tests; expect failures before implementation.
- [ ] Generate migration via `supabase migration new complete_repair`; add `repair_order_id` links and necessary constraints to inventory transactions, serials and warranties. Extend `inventory.js` and cloud mapping for `repair_used`/`repair` without faking `sold`/`sale`; complete in one locked database transaction with the active-staff check, stock/serial recheck, ledger rows, battery warranty, order status and audit fields.
- [ ] Re-run tests, including `node --test` and the repair SQL runner; expect all pass. Explicitly verify the rollback and permission assertions.

### Task 3: Cloud adapter, desktop repair page and session safety

**Files:** Modify `cloud-data.js`, `index.html`, `app.js`, `cloud-data.test.js`, `navigation.test.js`; create `repair-ui.test.js`.

**Interfaces:** Add `AppData.loadRepairOrders()`, `AppData.saveRepairOrder(order, lines, expectedUpdatedAt)`, `AppData.cancelRepairOrder(id)`, `AppData.completeRepairOrder(id, serialIdsByLine)`, `AppData.markRepairPaid(id)`. Every mutation reloads cloud state and propagates server errors; repair orders remain separate from `Inventory.validateState()` snapshots.

- [ ] Write failing adapter/UI tests: active-staff calls and anonymous rejection; create member/guest; search by number/phone/plate/original serial; quote without stock change; battery picker lists only in-stock IDs for that item; complete/paid/cancel button states; failed completion retains editable draft; mobile cannot navigate to repair page; logout clears pending results and printed customer details.
- [ ] Run `node --test`; expect the new tests to fail.
- [ ] Add a desktop-only repair tab and page; wire form, list, detail and action handlers to `AppData` and existing `setStatus`/session epoch patterns. Keep prices and totals from server responses, disable repeated submission, and update script cache versions.
- [ ] Re-run `node --test`; expect all pass. Check keyboard labels and status/error announcements.

### Task 4: Print layout and final acceptance gate

**Files:** Modify `index.html`, `app.js`, `style.css`, `repair-ui.test.js`.

**Interfaces:** `printRepairOrder(order, lines)` builds a print-only DOM view from text nodes (never unsanitized HTML) and calls `window.print()`; it labels draft/unpaid orders visibly.

- [ ] Write failing print tests: number, customer phone, plate/original serial, issue/resolution, parts and selected battery serials, labor, total, completion/payment labels; customer input must render as text, not HTML. Assert sign-out removes print content.
- [ ] Run `node --test repair-ui.test.js`; expect failures.
- [ ] Add existing-style `@media print` rules and a print document; preserve the current QR-label print behavior. Do not add a PDF library or a public customer-data URL.
- [ ] Run `node --test`, the repair SQL runner, and `git diff --check`; expect all pass. Do an authenticated desktop browser smoke test for create → quote → complete → pay → print, plus an anonymous/API permission check. Do not use a real customer's order for test mutation without approval.
- [ ] Report modified files, test evidence, deployment prerequisites and any remaining risks. Ask before Commit/Push or applying the formal Supabase migration; release database before website to avoid missing-RPC errors.
