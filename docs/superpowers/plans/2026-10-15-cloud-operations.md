# Cloud Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every formal inventory operation a Supabase-backed, role-protected, multi-device workflow while retaining IndexedDB only as a cache and migration source.

**Architecture:** Extend the current Postgres schema with supplier, purchasing, serial, and migration-state tables, then expose state changes through narrow transactional RPCs. Expand `cloud-data.js` into the only cloud snapshot mapper and writer; UI modules continue to operate on the validated browser state and reload the snapshot after a successful write.

**Tech Stack:** Static HTML/JavaScript, Node test runner, Supabase Postgres, Supabase Auth, RLS, PL/pgSQL RPCs, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-15-cloud-operations-design.md`

## Global Constraints

- All formal operational data is stored in Supabase; IndexedDB is cache, backup, and initial migration input only.
- The mobile navigation remains monthly-sales-only.
- Suppliers and purchases are admin-only; quotations, warranties, and warranty cases are writable by active staff but deletable only by admins.
- Every public-schema table uses RLS, explicit grants, and no anonymous access.
- A frontend must use only a publishable key; no service or secret key may be added to browser code.
- An admin-only, one-time import must create a backup before import and never duplicate already migrated data.

## Review Focus

- A clerk calling an admin RPC directly must receive a permission error and make no changes; test in Task 2 and Task 3.
- Two concurrent receipt attempts on one purchase must change stock and create serials once; test in Task 3.
- A failed migration must not set its migration marker or replace the existing cloud snapshot; test in Task 5.
- A stale IndexedDB cache must remain read-only and never overwrite a newer cloud value; test in Task 4.
- A serialized item whose quantity and supplied serials differ must reject the entire receipt; test in Task 3.

---

## File Structure

- `supabase/migrations/<generated>_cloud_operations.sql`: tables, indexes, grants, RLS policies, and secure functions.
- `supabase/tests/cloud_operations.test.sql`: role, RLS, receipt, and migration-marker integration tests.
- `cloud-data.js`: converts Supabase rows to `Inventory.validateState`, loads the full snapshot, and routes state deltas to secure RPCs.
- `cloud-data.test.js`: isolated JS contract tests for full snapshot mapping, stale-cache protection, and RPC request payloads.
- `app.js`: starts migration only through an admin confirmation flow; enables migrated desktop-only pages and keeps mobile monthly-sales routing.
- `navigation.test.js`: asserts desktop availability of migrated pages and unchanged mobile restriction.
- `storage.test.js`: validates backup-before-migration and retry-safe IndexedDB behaviour.
- `index.html`: removes `data-cloud-disabled` from migrated desktop pages and adds an admin-only migration status/control surface.

### Task 1: Create the cloud operations schema contract

**Files:**
- Create: `supabase/migrations/<generated>_cloud_operations.sql`
- Create: `supabase/tests/cloud_operations.test.sql`

**Interfaces:**
- Produces: `public.suppliers`, `public.purchases`, `public.purchase_lines`, `public.inventory_serials`, `public.app_migrations`.
- Produces: RLS policies and explicit `authenticated` grants consumed by Tasks 2–5.

- [ ] **Step 1: Write SQL tests for role grants and RLS denial**

Cover anonymous denial for every new table, clerk denial for supplier and purchase writes, and active-staff read access where specified.

- [ ] **Step 2: Run the SQL test to verify it fails**

Run: `supabase test db supabase/tests/cloud_operations.test.sql`

Expected: FAIL because the tables and policies do not exist.

- [ ] **Step 3: Create the migration with `supabase migration new cloud_operations`**

Define the five tables, foreign keys, immutable creator fields, status checks, indexes, RLS, revocations, and least-privilege grants described in the spec. Use UUID primary keys and timestamp columns consistent with existing migrations.

- [ ] **Step 4: Re-run the SQL role tests**

Run: `supabase test db supabase/tests/cloud_operations.test.sql`

Expected: PASS for allowed and denied paths.

- [ ] **Step 5: Run Supabase security advisors**

Run: `supabase db advisors --linked`

Expected: no new RLS or exposed-function finding caused by this migration.

- [ ] **Step 6: Commit the schema contract**

```bash
git add supabase/migrations supabase/tests/cloud_operations.test.sql
git commit -m "feat: add cloud operations schema"
```

### Task 2: Persist supplier and quotation workflows

**Files:**
- Modify: `cloud-data.js`
- Modify: `cloud-data.test.js`
- Modify: `supabase/migrations/<generated>_cloud_operations.sql`
- Modify: `supabase/tests/cloud_operations.test.sql`

**Interfaces:**
- Consumes: Task 1 tables and RLS policies.
- Produces: `loadSnapshot()` including suppliers, quotations, and quotation lines; admin-only supplier RPCs and active-staff quotation RPCs.

- [ ] **Step 1: Write failing cloud-data tests for supplier and quotation snapshot round trips**

Assert that a supplier retains contact fields and active state, and a quotation retains customer, salesperson, note, line snapshots, and totals after a cloud reload.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test cloud-data.test.js`

Expected: FAIL because the current snapshot mapper excludes both modules.

- [ ] **Step 3: Add transaction RPCs and frontend delta routing**

Use `create_or_update_supplier(p_supplier jsonb)` for admins and `save_quotation(p_quotation jsonb, p_lines jsonb)` for active staff. Both functions derive actor identity from `auth.uid()` and validate foreign keys and snapshots server-side.

- [ ] **Step 4: Extend `snapshotFromRows()` and `replaceCore()`**

Map cloud rows to the validated local state and send only add/update/delete deltas through the new RPCs; do not bulk-upsert historical quotation lines from a stale cache.

- [ ] **Step 5: Run JS and SQL tests**

Run: `node --test cloud-data.test.js && supabase test db supabase/tests/cloud_operations.test.sql`

Expected: PASS.

- [ ] **Step 6: Commit supplier and quotation support**

```bash
git add cloud-data.js cloud-data.test.js supabase
git commit -m "feat: sync suppliers and quotations"
```

### Task 3: Implement atomic purchase receipt and serial storage

**Files:**
- Modify: `supabase/migrations/<generated>_cloud_operations.sql`
- Modify: `supabase/tests/cloud_operations.test.sql`
- Modify: `cloud-data.js`
- Modify: `cloud-data.test.js`

**Interfaces:**
- Consumes: Task 1 purchase and serial tables.
- Produces: admin RPCs `save_purchase`, `receive_purchase`, and `mark_purchase_paid`; snapshot data for `purchases` and `serials`.

- [ ] **Step 1: Write failing SQL tests for `receive_purchase`**

Assert one receipt increases each item's stock once, writes inventory transactions and serials, rejects a second receipt, rejects a clerk, and rolls back when serialized quantities do not match supplied serials.

- [ ] **Step 2: Run the focused SQL test to verify it fails**

Run: `supabase test db supabase/tests/cloud_operations.test.sql`

Expected: FAIL because receipt RPCs do not exist.

- [ ] **Step 3: Implement `save_purchase`, `receive_purchase`, and `mark_purchase_paid`**

Lock the purchase row in `receive_purchase`, require `draft`, validate input JSON and supplier/item association, then update items, transactions, serials, receipt fields, and status in one transaction. Every function requires `app_private.is_admin()`.

- [ ] **Step 4: Map purchases and serials in `cloud-data.js`**

Read purchase headers, lines, and serials in the snapshot; route draft edits, receipt, and payment transitions exclusively to the new RPCs.

- [ ] **Step 5: Run all receipt tests**

Run: `node --test cloud-data.test.js inventory.test.js serials.test.js && supabase test db supabase/tests/cloud_operations.test.sql`

Expected: PASS, including duplicate-receipt and malformed-serial denial.

- [ ] **Step 6: Commit atomic purchase receipt**

```bash
git add cloud-data.js cloud-data.test.js supabase
git commit -m "feat: sync purchases and serialized receipts"
```

### Task 4: Sync warranties, cases, sales links, and serialized units

**Files:**
- Modify: `supabase/migrations/<generated>_cloud_operations.sql`
- Modify: `supabase/tests/cloud_operations.test.sql`
- Modify: `cloud-data.js`
- Modify: `cloud-data.test.js`

**Interfaces:**
- Consumes: Task 3 `inventory_serials` and existing warranty tables.
- Produces: `save_warranty`, `save_warranty_case`, and admin-only delete RPCs; full snapshot relations for sales, warranties, cases, and serials.

- [ ] **Step 1: Write failing tests for warranty and serial relationship mapping**

Assert a warranty reload retains sold serial identity and expiry, a case retains its warranty relation, active staff can save but cannot delete, and an invalid cross-item serial is rejected.

- [ ] **Step 2: Run focused JS and SQL tests to verify failure**

Run: `node --test cloud-data.test.js serials.test.js && supabase test db supabase/tests/cloud_operations.test.sql`

Expected: FAIL because cloud snapshot currently omits warranties, cases, and serials.

- [ ] **Step 3: Extend warranty schema and RPCs minimally**

Add only the missing serial and replacement relation columns required by the validated state. Functions must derive the actor, validate source-sale links, and retain existing delete restrictions.

- [ ] **Step 4: Extend full snapshot mapping**

Map serial, warranty, warranty case, sales, and sales-line relations into `Inventory.validateState`; keep cache fallback read-only when this full query fails.

- [ ] **Step 5: Run module and permission verification**

Run: `node --test cloud-data.test.js serials.test.js navigation.test.js && supabase test db supabase/tests/cloud_operations.test.sql`

Expected: PASS.

- [ ] **Step 6: Commit warranty and serial cloud links**

```bash
git add cloud-data.js cloud-data.test.js supabase
git commit -m "feat: sync warranties and serial units"
```

### Task 5: Add safe one-time IndexedDB migration

**Files:**
- Modify: `app.js`
- Modify: `storage.test.js`
- Modify: `cloud-data.js`
- Modify: `cloud-data.test.js`
- Modify: `index.html`

**Interfaces:**
- Consumes: Tasks 1–4 full snapshot and `app_migrations` marker.
- Produces: `migrateLocalStateToCloud()` returning `{ migrated, backupCreated, state }` only after a successful admin-only transaction.

- [ ] **Step 1: Write failing tests for migration safety**

Assert the backup export is initiated before migration, a clerk cannot start migration, a failed upload leaves no marker, and an existing marker skips a second import.

- [ ] **Step 2: Run migration tests to verify failure**

Run: `node --test storage.test.js cloud-data.test.js`

Expected: FAIL because there is no one-time migration workflow.

- [ ] **Step 3: Implement admin confirmation and migration flow**

Add a desktop admin control that creates a timestamped local backup, validates the full local state, invokes one transactional import RPC, reloads the cloud snapshot, and persists only the returned cloud state.

- [ ] **Step 4: Run migration tests**

Run: `node --test storage.test.js cloud-data.test.js`

Expected: PASS.

- [ ] **Step 5: Commit safe migration flow**

```bash
git add app.js index.html storage.test.js cloud-data.js cloud-data.test.js
git commit -m "feat: migrate local operations data to cloud"
```

### Task 6: Enable desktop modules and verify multi-device behaviour

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `navigation.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1–5 cloud-backed snapshot and authorization behaviour.
- Produces: enabled desktop module navigation with unchanged monthly-sales-only mobile routing and operator-facing backup/migration guidance.

- [ ] **Step 1: Write failing navigation and access tests**

Assert the four desktop modules have no `data-cloud-disabled` attribute, a mobile route still resolves to `monthly-sales`, and a clerk never receives supplier/purchase controls.

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `node --test navigation.test.js`

Expected: FAIL because the modules remain marked as cloud-disabled.

- [ ] **Step 3: Enable only migrated desktop pages**

Remove cloud-disabled flags after Task 5 is live; retain mobile routing, role guards, status messages, and confirmation prompts.

- [ ] **Step 4: Add operational documentation**

Document backup cadence, first migration prerequisites, retry behaviour, desktop-only restrictions, and the two-account acceptance test.

- [ ] **Step 5: Run full local and database verification**

Run: `node --test *.test.js && supabase test db supabase/tests/cloud_operations.test.sql && git diff --check`

Expected: all new tests pass; any pre-existing failure is documented before release.

- [ ] **Step 6: Run deployment and two-account acceptance tests**

Verify an admin creates and receives a purchase on desktop, a second authorized account reads its resulting stock and monthly sales after reload, a clerk cannot access supplier/purchase APIs, and a phone displays only monthly sales.

- [ ] **Step 7: Commit the UI enablement**

```bash
git add index.html app.js navigation.test.js README.md
git commit -m "feat: enable cloud operations modules"
```

## Self-Review

- Spec coverage: Tasks 1–4 cover the full cloud schema and role model; Task 3 covers atomic receipt; Task 5 covers backup and one-time migration; Task 6 covers desktop/mobile UI and live verification.
- Interface consistency: all cloud mutation paths use RPCs, while `loadSnapshot()` remains the single state mapping entrypoint.
- Review-focus coverage: direct clerk denial is tested in Tasks 1–3, concurrent receipt and serial mismatch in Task 3, stale-cache safety in Task 4, and migration retry safety in Task 5.
- Proportion: tasks define contracts and test commands rather than implementation bodies, leaving normal code decisions to the executor.
