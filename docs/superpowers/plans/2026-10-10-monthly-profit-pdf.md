# 月銷售利潤與 PDF 匯出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immutable per-sale cost snapshots, an admin-only monthly gross-profit report, and browser-based PDF export.

**Architecture:** Extend the existing sale-line shape with an optional `unitCost`, populated from item cost at checkout. A small reporting helper separates known-profit totals from legacy sales with no cost snapshot. The monthly-sales view renders admin-gated summary/PDF markup, while the existing print stylesheet isolates that report for browser PDF saving.

**Tech Stack:** Vanilla JavaScript, existing IndexedDB state validation, Node.js built-in tests, HTML/CSS print media.

**Spec:** `docs/superpowers/specs/2026-10-10-monthly-profit-pdf-design.md`

## Global Constraints

- New sales must snapshot current item cost as `unitCost`; changing an item cost must not alter prior sales.
- Legacy sales without `unitCost` remain viewable and are excluded from known cost/profit totals.
- Only `admin` may view cost, gross profit, gross margin or PDF controls.
- PDF export uses the browser print dialog; do not add a PDF library, upload files, or email reports.
- Maintain compatibility with existing IndexedDB backups and current `sales` data.

## Review Focus

- A sale with zero cost must be treated as a valid known cost, not as missing data; test in Task 1.
- A legacy sale with no `unitCost` must not silently count as zero cost; test in Task 1.
- An item cost change after checkout must not alter monthly profit; test in Task 1.
- Clerk role must not display profit or PDF controls even if a hash route points to monthly sales; test in Task 2.
- Print rules must exclude the app shell and include only the monthly report; test in Task 2.

---

### Task 1: Snapshot sale cost and calculate monthly profit

**Files:**
- Modify: `inventory.js`
- Modify: `inventory.test.js`

**Interfaces:**
- Consumes: current `recordSale`, `recordSaleBatch`, `salesForMonth` state shape.
- Produces: sale records with optional `unitCost`; `monthlyProfit(state, month): { revenue, cost, profit, knownLineCount, missingCostLineCount, margin }`.

- [ ] **Step 1: Write failing inventory tests**

Add tests that assert `recordSale` and `recordSaleBatch` store the source item `cost` as `unitCost`, that zero is preserved, and that a later `updateItem` cost change does not alter recorded sales. Add assertions for `monthlyProfit` totals with one known-cost sale and one legacy sale without `unitCost`.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test inventory.test.js`

Expected: FAIL because sales do not contain `unitCost` and `monthlyProfit` does not exist.

- [ ] **Step 3: Implement the cost snapshot and reporting helper**

In `inventory.js`, add `unitCost` to sale construction in `recordSale` and `recordSaleBatch`. Export `monthlyProfit`, using only sales where `Number.isFinite(sale.unitCost)`; include `unitCost: 0` as known, and return `margin: null` when known revenue is zero.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test inventory.test.js`

Expected: PASS.

### Task 2: Build the admin monthly report and printable PDF view

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `style.css`
- Modify: `navigation.test.js`

**Interfaces:**
- Consumes: `Inventory.monthlyProfit(state, month)`, `document.body.dataset.role`, and monthly sales state.
- Produces: `#monthly-profit-cost`, `#monthly-profit-total`, `#monthly-profit-margin`, `#export-monthly-pdf`, and `#monthly-report-print` admin-only controls.

- [ ] **Step 1: Write failing navigation tests**

Add assertions that the monthly-sales markup contains admin-gated profit summary IDs, a PDF action, a dedicated print document, and CSS selectors that print only that document. Assert `app.js` reads `monthlyProfit` and binds the export button.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test navigation.test.js`

Expected: FAIL because the monthly page has no profit/PDF elements.

- [ ] **Step 3: Implement the smallest monthly report UI**

Import `monthlyProfit` in `app.js`. Render known cost, gross profit and margin only when `document.body.dataset.role === 'admin'`; append a cost-insufficient warning and per-line `—` values for legacy sales. Add `showMonthlyReportPrint()` that fills `#monthly-report-print`, adds a `printing-monthly-report` body class, and calls `window.print()`; clear the class in the existing `afterprint` handler.

In `index.html`, add the admin-gated cards/button and a hidden print document. In `style.css`, add report-specific print rules so `body.printing-monthly-report #monthly-report-print` is the only printable content.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test navigation.test.js && node --check app.js && node --check inventory.js`

Expected: PASS and exit code 0.

### Task 3: Preserve future cloud-model compatibility and complete verification

**Files:**
- Modify: `supabase/migrations/20261010000000_multiuser_inventory.sql`
- Create: `supabase/migrations/20261010000003_add_sale_line_cost_snapshot.sql`
- Modify: `supabase/tests/multiuser_inventory.test.sql`
- Modify: `docs/superpowers/runbooks/supabase-setup.md`

**Interfaces:**
- Consumes: `public.sale_lines` and the `unitCost` browser data contract from Task 1.
- Produces: `public.sale_lines.unit_cost numeric(12,2)`, nullable only for legacy imported records, and an `app_private.create_sale(jsonb)` that snapshots a current `item_costs.cost` value.

- [ ] **Step 1: Write the failing database shape check**

Add a query to `supabase/tests/multiuser_inventory.test.sql` that raises an exception when `public.sale_lines.unit_cost` does not exist, and a transaction-scoped test fixture proving a new `create_sale` line receives a non-null `unit_cost`.

- [ ] **Step 2: Run the check before migration**

Run the focused test SQL against the configured Supabase project.

Expected: FAIL because the column does not exist.

- [ ] **Step 3: Add the non-destructive migration**

Add nullable `unit_cost numeric(12,2) check (unit_cost >= 0)` to `public.sale_lines`. Replace `app_private.create_sale(jsonb)` so it locks the item, obtains its current `item_costs.cost`, rejects a missing cost row, and inserts that value into `sale_lines.unit_cost` in the same transaction. Update the base migration so fresh projects include the column and the same insert behavior. Document that imports of legacy sales may omit the value.

- [ ] **Step 4: Apply and verify the migration**

Apply the new migration through the Supabase migration tool, rerun the focused SQL check, run the database security advisor, and run the complete local suite.

Expected: database check passes, advisor has no new security findings, `node --test` passes.

## Self-Review

- Spec coverage: Task 1 handles immutable snapshots and legacy data; Task 2 handles admin reporting/PDF/role display; Task 3 keeps the future cloud table contract aligned.
- Step scan: every task begins with a concrete failing test/check and ends in focused verification.
- Type consistency: all layers use `unitCost` in JavaScript and `unit_cost` in PostgreSQL; only adapters will translate naming when cloud writes are introduced.
- Review focus: zero-cost, legacy sales, cost edits, clerk UI visibility and print isolation each have a named test owner.
- Proportion: the plan specifies contracts and checks without prescribing implementation bodies beyond the database column.
