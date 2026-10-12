# Multiuser Auth and Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the inventory app into a shared, authenticated system with secure admin and clerk permissions enforced by Supabase.

**Architecture:** Supabase Auth identifies password-login users, PostgreSQL stores the shared operating data, and RLS plus server-side database functions enforce role and stock rules. The browser app gains an authenticated data client and a read-only offline cache; it must never hold a service-role key or treat hidden UI as authorization.

**Tech Stack:** Supabase Auth, Supabase PostgreSQL, Row Level Security, SQL migrations, vanilla JavaScript, IndexedDB read-only cache, Node.js built-in tests.

**Spec:** `docs/superpowers/specs/2026-10-10-multiuser-auth-and-roles-design.md`

## Global Constraints

- A Supabase project, project URL and browser-safe publishable key are required before implementation.
- Never expose `service_role`, secret keys, or password management logic in browser code.
- All public tables need explicit grants and RLS policies.
- Authorization comes from protected profile/application role data, never mutable user metadata.
- Admin sees costs; clerk must not receive cost values from an API response.
- Offline mode is read-only; no write queue or conflict merge is in scope.
- Preserve existing IndexedDB and JSON backups; migration must not delete local data.
- All stock-changing operations use one server-side transaction that rechecks stock.

## Review Focus

- Clerk direct API requests: cost data, delete operations and account records must remain inaccessible even if UI is manipulated.
- Disabled profile/session: must block every read/write after session refresh, not only hide pages.
- Concurrent sales of the final unit: exactly one transaction succeeds and stock never goes below zero.
- Import failure halfway through: existing cloud and local backup data must remain recoverable.
- Offline or expired session: UI becomes read-only with a clear reason and cannot submit a stale write.

---

### Task 1: Create the Supabase project and secure schema

**Files:**
- Create: `supabase/migrations/<generated>_multiuser_inventory.sql`
- Create: `supabase/tests/multiuser_inventory.test.sql`
- Create: `docs/superpowers/runbooks/supabase-setup.md`

**Interfaces:**
- Consumes: Supabase project reference, Auth schema and the approved role model.
- Produces: `profiles`, inventory, customer, quotation, sales, audit and backup tables; roles `admin`/`clerk`; secure RPCs `create_sale(...)`, `create_staff_account(...)`, `deactivate_staff_account(...)`.

- [ ] **Step 1: Provision a Supabase project and record only safe browser configuration**

User creates or authorizes a Supabase project. Store the project URL and browser-safe publishable key in a local ignored configuration file; do not request or place the service-role key in browser files. Confirm the current Supabase changelog and Auth/RLS documentation before writing SQL.

- [ ] **Step 2: Write failing database tests for authorization and stock integrity**

Create SQL tests covering:

```sql
-- Clerk cannot select cost-bearing data or audit records.
-- Clerk cannot delete business records or manage profiles.
-- Disabled clerk cannot read or write.
-- Two sales of one remaining unit result in one success and stock = 0.
-- Admin may view cost and perform permitted administration.
```

- [ ] **Step 3: Run the database tests to verify they fail**

Run the Supabase-supported SQL test command discovered from the installed CLI/MCP documentation.  
Expected: FAIL because schema, grants, RLS policies and functions do not exist.

- [ ] **Step 4: Implement schema, RLS, grants and RPCs in a generated migration**

Generate a migration using the current Supabase CLI; do not invent its timestamp. Create separate cost-restricted storage/view so clerk query responses cannot contain cost. Enable RLS on every public table; explicitly grant only needed operations. Use protected `profiles.role` and `profiles.active` predicates. Implement `create_sale` as one database transaction that verifies role, active state and stock before inserting sale lines, inventory transactions and audit records.

- [ ] **Step 5: Add account lifecycle controls outside browser privilege**

Implement staff creation, deactivation and password-reset initiation through an Edge Function or other trusted server-side endpoint that holds the service role. Revoke sessions when deactivating a profile; browser code can only call the authenticated, role-checked endpoint.

- [ ] **Step 6: Run database tests and security checks**

Run the focused SQL/RLS suite and Supabase database advisors.  
Expected: authorization tests pass, concurrent-sale test proves no negative stock, advisors show no unresolved security issue.

### Task 2: Add authenticated app bootstrap and role-based interface

**Files:**
- Create: `supabase-client.js`
- Create: `auth-ui.js`
- Modify: `index.html`
- Modify: `app.js`
- Modify: `style.css`
- Modify: `navigation.test.js`

**Interfaces:**
- Consumes: browser-safe Supabase configuration and Task 1 `profiles` row/RPCs.
- Produces: `window.AppAuth.requireActiveUser(): Promise<{ id, role, displayName }>` and `window.AppData` authenticated read/write APIs.

- [ ] **Step 1: Write failing browser-structure and role-visibility tests**

Add tests requiring a login form, sign-out control, offline read-only status, admin-only account area, and no cost column/card rendered for clerk-mode UI. Add a test that API calls use the authenticated data client rather than direct IndexedDB for online writes.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test navigation.test.js`  
Expected: FAIL because no authenticated bootstrap or role-aware UI exists.

- [ ] **Step 3: Implement authentication bootstrap**

Load the current official browser Supabase client using a pinned version and a local, ignored public configuration file. Implement email/password sign-in, sign-out and session refresh. On every startup, retrieve the protected profile and reject missing or inactive accounts before rendering business data.

- [ ] **Step 4: Implement role-aware UI without treating it as security**

Add `data-role` controls to hide admin functions for clerk users: costs, total cost, delete buttons, import/export, accounts and audits. Preserve server/RLS enforcement from Task 1 as the source of truth. Give permissions and offline failures explicit Chinese status messages.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `node --test navigation.test.js && node --check app.js && node --check auth-ui.js && node --check supabase-client.js`  
Expected: PASS and exit code 0.

### Task 3: Migrate business data access and provide read-only offline cache

**Files:**
- Create: `cloud-data.js`
- Modify: `app.js`
- Modify: `storage.js`
- Modify: `storage.test.js`
- Modify: `inventory.test.js`

**Interfaces:**
- Consumes: Task 1 schema/RPCs and Task 2 active user/session.
- Produces: `window.AppData.loadSnapshot()`, `saveBusinessAction(action)`, and `loadOfflineSnapshot()` returning data with `{ readonly, source }` status.

- [ ] **Step 1: Write failing data-path tests**

Add tests proving online reads hydrate the existing render-state shape, online sales call the server-side transaction rather than client stock mutation, failed writes do not alter UI state/cache, and offline fallback exposes cached data as read-only.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `node --test storage.test.js inventory.test.js`  
Expected: FAIL because cloud snapshot and read-only fallback APIs do not exist.

- [ ] **Step 3: Implement central data adapters**

Map PostgreSQL records to the current app state shape. Replace operational IndexedDB writes with authenticated Supabase queries/RPCs. After successful online reads, update IndexedDB cache; never queue writes while offline. If network/session validation fails but a cached snapshot exists, render it with `readonly: true` and disable every mutation control.

- [ ] **Step 4: Implement live refresh and server-error recovery**

Subscribe to required shared-data changes or use a documented refresh strategy; refresh on successful writes and visibility regain. On permission, stock or network failure, retain the last valid snapshot and present the server message without a false success state.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `node --test storage.test.js inventory.test.js && node --check cloud-data.js && node --check app.js`  
Expected: PASS and exit code 0.

### Task 4: Build controlled migration, audit views and end-to-end checks

**Files:**
- Create: `migration.js`
- Modify: `index.html`
- Modify: `app.js`
- Modify: `navigation.test.js`
- Modify: `docs/superpowers/runbooks/supabase-setup.md`

**Interfaces:**
- Consumes: validated JSON backup, Task 1 admin-only migration endpoint, Task 2 admin session.
- Produces: admin-only import/export/audit flow with explicit backup and completion status.

- [ ] **Step 1: Write failing tests for migration safety and audit visibility**

Add tests that require admin-only migration controls, local JSON export before cloud import, server validation before write, and no audit display for clerk users.

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test navigation.test.js`  
Expected: FAIL because controlled cloud migration and audit UI do not exist.

- [ ] **Step 3: Implement protected initial migration**

Require an admin session; validate the JSON using current inventory rules; download the local source backup; invoke the server-side import endpoint that creates a cloud backup and writes all data transactionally. Keep existing IndexedDB/localStorage untouched regardless of outcome.

- [ ] **Step 4: Implement admin audit log view**

Show paginated audit entries only after the server confirms admin role. Include actor, action, target summary and time; do not expose this endpoint or data to clerk role.

- [ ] **Step 5: Verify end-to-end behavior in two browser profiles**

1. Migrate a copy of existing JSON as admin and confirm local data remains.
2. Log in as clerk in a second browser profile; confirm costs, delete controls, account management, imports/exports and audits are absent and API calls are rejected.
3. Sell the final unit simultaneously from two sessions; confirm one succeeds, one receives stock error and final stock is zero.
4. Disconnect clerk; confirm cached data remains viewable and every mutation control is disabled.
5. Deactivate clerk as admin; refresh clerk session and confirm access ends.

- [ ] **Step 6: Run the complete verification suite**

Run project tests, all syntax checks, Supabase SQL tests, RLS policy tests and database advisors.  
Expected: all pass with no unresolved security advisories.

## Self-Review

- Spec coverage: tasks cover centralized Auth/database, two roles, protected costs, RLS/grants, migration backup, read-only offline cache, server-side stock transactions, audit trail and acceptance tests.
- Step scan: each task has a red test, focused verification, a minimal implementation boundary and a concrete completion test.
- Type consistency: Task 1 provides profile and secure RPC contracts; Task 2 exposes active user/data client; Task 3 consumes those for business writes; Task 4 consumes the admin session and import endpoint.
- Review Focus coverage: direct clerk API, disabled sessions and stock races are Task 1; stale/offline UI and server errors are Task 3; migration durability is Task 4.
- Proportion: plan contains interfaces and checkable steps, not implementation code or credentials.
