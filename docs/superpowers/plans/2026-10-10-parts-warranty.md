# 零件與用品保固管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add part/accessory warranty records, manual warranty entry, repair-case tracking, and optional customer-linked automatic warranty creation at sale checkout.

**Architecture:** Extend the existing local inventory state with warranty records and repair cases, preserving older backups by defaulting missing arrays and warranty months. Build warranty actions in `inventory.js` so sales, manual entries and status updates share one validation layer; add a dedicated page in the single-page UI. Mirror the future multiuser data model with RLS-ready Supabase tables without changing the current IndexedDB source-of-truth workflow.

**Tech Stack:** Vanilla JavaScript, IndexedDB, Node.js built-in tests, Supabase PostgreSQL migrations and RLS.

**Spec:** `docs/superpowers/specs/2026-10-10-parts-warranty-design.md`

## Global Constraints

- `warrantyMonths` is a non-negative integer; `0` means no warranty.
- Customer selection during sale is optional; automatic warranty requires both a selected customer and `warrantyMonths > 0`.
- Warranty names, barcodes, purchase dates and expiry dates are snapshots and must not change when item data changes.
- Store repair cases with only: pending, in_progress, completed, or not_covered status.
- Clerk cannot delete warranties/cases or change product warranty months; cloud RLS, not UI hiding, is the authority when cloud writes are enabled.
- Old backups load with `warrantyMonths: 0`, empty warranties, and empty cases; do not create historical warranties.

## Review Focus

- Month-end expiry must use calendar-month addition (e.g. Jan 31 + one month), not a fixed day count; test in Task 1.
- A multi-item sale must create a distinct warranty for every eligible line, not only the first line; test in Task 1.
- A sale with no customer must remain valid and create no warranty; test in Task 1.
- An expired warranty may have cases, but its expired status must be visible; test in Task 2.
- A clerk must not receive delete controls, including after a hash-route change; test in Task 2.

---

### Task 1: Extend the state model and warranty business rules

**Files:**
- Modify: `inventory.js`
- Modify: `inventory.test.js`

**Interfaces:**
- Consumes: current item, customer, sale and backup state shapes.
- Produces: `createWarranty`, `updateWarranty`, `deleteWarranty`, `addWarrantyCase`, `updateWarrantyCase`, `deleteWarrantyCase`, `warrantiesForFilter`, and extended `recordSaleBatch` accepting optional `customerId`.

- [ ] **Step 1: Write failing state tests**

Add tests for default `warrantyMonths: 0`, valid warranty-month validation, calendar expiry dates, manual warranty validation, repair-case status validation, and old-backup normalization. Add a multi-line sale test asserting that only eligible lines create warranties when `customerId` exists, and a no-customer sale test asserting no warranties are created.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test inventory.test.js`

Expected: FAIL because warranty data/actions and sale customer input do not exist.

- [ ] **Step 3: Implement state normalization and actions**

In `inventory.js`, add `warrantyMonths` to normalized items, optional `warranties` and `warrantyCases` arrays to `emptyState`/`validateState`, immutable snapshot construction, and date/status validation. Update `recordSaleBatch(state, { lines, customerId })` to create warranties atomically only after sale stock validation succeeds. Keep `recordSale` behavior compatible and export all warranty helpers.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test inventory.test.js`

Expected: PASS.

### Task 2: Add checkout customer selection and warranty management UI

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `style.css`
- Modify: `navigation.test.js`

**Interfaces:**
- Consumes: warranty helpers from Task 1 and `document.body.dataset.role` from the login UI.
- Produces: sales customer selection, `data-page="warranties"`, warranty filter/list/detail controls, and role-aware delete controls.

- [ ] **Step 1: Write failing UI tests**

Add tests requiring an optional `sale-customer` selector, a warranties navigation/page section, a warranty-month item field marked admin-only, warranty search/filter controls, and a repair-case form. Assert that app code passes selected customer ID to `recordSaleBatch`, reads warranty helpers, and applies clerk delete restrictions.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test navigation.test.js`

Expected: FAIL because none of the warranty controls exist.

- [ ] **Step 3: Implement the smallest complete warranty interface**

Render customers in the optional sale selector. Add warranty months to the item form only for admins. Add a warranty page with search, status filter, manual warranty form, selected-warranty detail, repair-case form/list, and confirmation before admin deletion. Use existing `saveState`, `setStatus`, and form-error patterns. Render expiry state from current date; keep cases editable by clerk, but only render delete controls for admin.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test navigation.test.js && node --check app.js && node --check inventory.js`

Expected: PASS and exit code 0.

### Task 3: Add the Supabase warranty schema and policies

**Files:**
- Modify: `supabase/migrations/20261010000000_multiuser_inventory.sql`
- Create: `supabase/migrations/20261010000003_add_parts_warranties.sql`
- Modify: `supabase/tests/multiuser_inventory.test.sql`
- Modify: `docs/superpowers/runbooks/supabase-setup.md`

**Interfaces:**
- Consumes: `items`, `customers`, `sale_lines`, `profiles`, and protected helper predicates from the current cloud schema.
- Produces: `items.warranty_months`, nullable `sales.customer_id`, `warranties`, `warranty_cases`, explicit grants/RLS policies, and `create_sale(p_lines jsonb, p_customer_id uuid)` for future sync work.

- [ ] **Step 1: Write the failing database-shape and RLS checks**

Extend `supabase/tests/multiuser_inventory.test.sql` with checks for warranty tables, `items.warranty_months`, RLS enabled on both tables, and no delete policy/grant for clerk-equivalent authenticated callers.

- [ ] **Step 2: Run the focused SQL check before migration**

Run the focused SQL against the configured Supabase project.

Expected: FAIL because the warranty schema does not exist.

- [ ] **Step 3: Implement the non-destructive secure migration**

Add `warranty_months integer not null default 0 check (warranty_months >= 0)` to items and nullable `customer_id` to sales. Create `warranties` and `warranty_cases` with foreign keys and snapshot fields. Enable RLS, grant active staff read/create/update authority, restrict deletes to admins, and replace the cloud sale transaction with `create_sale(p_lines jsonb, p_customer_id uuid)`, which creates warranty records only when a customer is supplied. Update the base migration to match fresh-project behavior.

- [ ] **Step 4: Apply and verify the migration**

Apply the migration through the Supabase migration tool, rerun the focused SQL checks, run the database security advisor, and run the complete local suite.

Expected: schema/RLS checks pass, no new security advisor findings, and `node --test` passes.

## Self-Review

- Spec coverage: Task 1 supplies dates, snapshots, automatic/manual warranties and cases; Task 2 supplies the sales and warranty flows plus role UI; Task 3 supplies the future cloud schema and RLS enforcement.
- Step scan: each task has a failing test/check, focused execution, minimal implementation boundary and a passing verification.
- Type consistency: browser state uses `warrantyMonths`, `warranties` and `warrantyCases`; cloud uses `warranty_months`, `warranties` and `warranty_cases` with adapters translating names later; cloud sales accept nullable `p_customer_id`.
- Review focus: date arithmetic, multi-item sales, no-customer sales, expiry display and clerk delete exposure each have a specified test owner.
- Proportion: this plan commits interfaces and behaviors, not implementation transcripts.
