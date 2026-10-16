# Monthly Salesperson Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 結帳時必選業務員，讓店長查看按台灣月份統計的業務員件數與銷售金額，且一般員工無法讀取個人績效。

**Architecture:** 維持公開銷售資料與登入者欄位；將每張訂單的業務歸屬放在 `app_private`，由原子結帳函式同交易寫入。月績效僅透過再次驗證店長身分的 RPC 讀取。前端仍由既有狀態與雲端儲存接點處理結帳及名單，但不把個人績效寫進一般員工可讀的快照。

**Tech Stack:** PostgreSQL / Supabase SQL migrations and RLS, vanilla JavaScript, Node tests, PGlite SQL tests.

**Spec:** `docs/superpowers/specs/2026-10-15-monthly-salesperson-performance-design.md`

## Global Constraints

- 一張訂單只歸屬一位業務員；結帳時必選啟用中的業務員，且與結帳登入者分開。
- 第一版只計售出件數與銷售金額，不計毛利、佣金、退貨或目標達成率。
- 月份一律使用 `Asia/Taipei` 的月初含、次月月初不含區間；舊銷售可留在總覽但不可猜測歸屬。
- 個人績效只給店長；一般員工保有既有月總覽，並且不能透過直接 RPC 或 Data API 讀取歸屬。
- 遵守 `AGENTS.md`：各階段回報；未經使用者另外明確同意，不 `git add`、Commit、Push 或部署；不 force push、reset hard、刪除未提交修改。

## Review Focus

- 空白或不存在的業務員 ID：結帳拒絕、不得產生任何銷售或扣庫存（Task 2、3）。
- 停用業務員與並發停用：資料庫在交易內驗證啟用狀態，新單拒絕、舊績效保留（Task 2）。
- 多明細同一張單：件數加總明細，訂單總額只加一次（Task 4）。
- 台灣月界線兩側的 UTC 時間：前端月總覽與 RPC 得到一致月份（Task 4）。
- 一般員工直接呼叫績效 RPC、查私有表或偽造前端角色：資料庫拒絕（Task 2、4）。

---

### Task 1: 業務員名單確實寫回雲端

**Files:** Modify `cloud-data.js` (`replaceCore`); test `cloud-data.test.js`; inspect existing `supabase/migrations/*salespeople*.sql` and SQL RLS tests before changing DB policy.

**Interfaces:** Produce `replaceCore(previous, next, actorId)` handling `salespeople` added/changed rows with `{id,name,active}` and `created_by` only on insert; retain existing `loadSnapshot()` mapping.

- [ ] **Step 1: Write failing tests.** In `cloud-data.test.js`, assert a newly added salesperson uses `insert` with `created_by=actorId`; edit/disable uses `upsert` without `created_by`; unchanged entries cause no write; a cloud reload returns the saved list. Test admin-denial handling through returned RLS error.
- [ ] **Step 2: Run `node --test cloud-data.test.js`; confirm new assertions fail.**
- [ ] **Step 3: Implement only changed-row writes in `cloud-data.js`.** Follow the existing customer insert/update split, preserve creator on update, and propagate database errors to the UI.
- [ ] **Step 4: Run `node --test cloud-data.test.js`; expect pass.** Report changed files and result; do not commit.

### Task 2: 原子結帳及私有歸屬

**Files:** Create `supabase/migrations/<next-timestamp>_monthly_salesperson_attribution.sql`, `supabase/tests/run-monthly-salesperson-local.mjs`, `supabase/tests/monthly_salesperson.test.sql`; modify `supabase/tests/cloud_operations.test.sql`, `supabase/tests/warranty_serial.test.sql`, and any SQL fixture using two-argument checkout.

**Interfaces:** Produce `public.create_sale_with_serials(p_lines jsonb, p_customer_id uuid, p_salesperson_id uuid) returns uuid`; private attribution table keyed by `sale_id`, with `salesperson_id` and `salesperson_name` snapshot. Preserve audit logging via `app_private.create_sale_with_serials_logged` and existing sale side effects. The old two-argument public signature must raise a refresh/select-salesperson error, not complete a sale.

- [ ] **Step 1: Write failing SQL tests.** Test empty, unknown, and inactive `p_salesperson_id`; successful multi-line sale creates one private attribution row with name snapshot; failure after validation rolls back sale, inventory, serial, warranty and attribution; prior two-argument call cannot sell; authenticated non-admin cannot `SELECT` attribution directly. Update successful existing checkout test calls to pass a seeded active salesperson.
- [ ] **Step 2: Create a focused local PGlite runner based on `supabase/tests/run-serialized-local.mjs`, loading all migrations then `monthly_salesperson.test.sql`; run `PGLITE_MODULE=<local PGlite module path> node supabase/tests/run-monthly-salesperson-local.mjs` and verify failure for the missing three-argument contract.** Discover the installed module path locally; do not run a live migration here.
- [ ] **Step 3: Implement the migration.** Create `app_private.sale_salesperson_attributions` with `sale_id` primary key referencing `public.sales` and snapshot name, revoke direct access from `anon`/`authenticated`, enable RLS; extend the private sale function, audit wrapper, and public wrapper to take `p_salesperson_id`. Lock/read the active salesperson in the same transaction before sales insert; write attribution after the sale header; guard old two-argument entry points with a clear error. Keep existing grants and `SECURITY DEFINER` search-path hardening.
- [ ] **Step 4: Run the focused local PGlite command from Step 2 plus affected SQL tests and ensure pass.** Report migration file and test results; do not apply to the live database or commit without a separate execution approval.

### Task 3: 結帳表單必填與雲端傳參

**Files:** Modify `index.html`, `app.js`, `inventory.js`, `cloud-data.js`; test `inventory.test.js`, `cloud-data.test.js`, `navigation.test.js` (use actual test file names discovered in repo).

**Interfaces:** Consume Task 2's `p_salesperson_id`. `recordSaleBatch(state, {lines,customerId,salespersonId,createdBy,createdByAccount})` adds `salespersonId` to every new local sale line; cloud `replaceCore` passes one shared `p_salesperson_id` with the batch. `renderSaleSalespeople()` populates only active choices and retains only valid selection.

- [ ] **Step 1: Write failing tests.** Assert no selection, unknown ID, inactive ID and empty list block checkout with useful messages; valid selection is copied to all lines; cloud RPC includes the exact selected UUID; mismatched salesperson IDs across a batch are rejected before RPC; `recordSale` cannot bypass mandatory selection. Existing serial/customer validation must still work.
- [ ] **Step 2: Run `node --test inventory.test.js cloud-data.test.js navigation.test.js`; confirm the new tests fail.**
- [ ] **Step 3: Implement.** Add required `#sale-salesperson` select to `index.html`; render active choices from `state.salespeople` in `app.js`; pass selected ID through sale submit and reset; validate in `recordSaleBatch` and `recordSale`; send one ID via `cloud-data.js`; advance changed script cache query versions in `index.html`.
- [ ] **Step 4: Run the same targeted tests and expect pass.** Report behavior and results; do not commit.

### Task 4: 店長月績效與統一台灣月份

**Files:** Extend Task 2 SQL migration or create the next ordered migration; modify `supabase/tests/cloud_operations.test.sql`, `inventory.js`, `app.js`, `index.html`, `cloud-data.js`; test `inventory.test.js`, `navigation.test.js`, `cloud-data.test.js`.

**Interfaces:** Produce `public.get_monthly_salesperson_performance(p_month text)` returning `{salesperson_id,salesperson_name,quantity,total}` rows to authenticated admins only. Produce `AppData.loadMonthlySalespersonPerformance(month)` for `app.js`; use `salesForMonth(state, month)` with Taiwan-calendar filtering for existing totals.

- [ ] **Step 1: Write failing SQL tests.** Seed a two-line sale crossing no month boundary and assert one salesperson row, quantities summed, order `sales.total` counted once. Seed UTC timestamps just before/after Taiwan month start and assert correct inclusion. Assert old unattributed sales remain in overview but not personal results; inactive salesperson history remains; staff, unauthenticated and direct private-table reads fail.
- [ ] **Step 2: Run `PGLITE_MODULE=<local PGlite module path> node supabase/tests/run-monthly-salesperson-local.mjs`; confirm expected failures.**
- [ ] **Step 3: Implement admin-only reporting RPC.** Validate `YYYY-MM`, calculate Taiwan bounds, filter on sale header creation time, group by stable ID and snapshot name, sum line quantities and distinct sale totals without join multiplication; check `app_private.is_admin()` or the existing equivalent server-side role check and revoke public/anon execute. Keep private table inaccessible through Data API.
- [ ] **Step 4: Run the same local PGlite command; expect pass.**
- [ ] **Step 5: Write failing UI/unit tests.** Assert `salesForMonth` handles Taiwan boundaries; manager sees grouped table and loading/error/empty states; staff sees no personal table and makes no performance RPC call; existing totals and details remain; heading for the login account reads `結帳人`.
- [ ] **Step 6: Run `node --test inventory.test.js cloud-data.test.js navigation.test.js`; confirm failures.**
- [ ] **Step 7: Implement UI/client.** Add admin-only monthly table, loader and failure state; invoke RPC only for admin upon month/view change and discard stale responses when month changes; do not place personal results in shared state or persistent storage. Update `salesForMonth` to use the same Taiwan month boundary and advance script cache versions.
- [ ] **Step 8: Run targeted tests and full `node --test`; expect pass.** Run `git diff --check`, review SQL grants/RLS, then report all modified files and outstanding live validation. Do not apply migrations, Commit, Push or deploy without a distinct authorized stage.

## Execution gate

After code and local tests, request explicit permission before applying any migration to the live Supabase project. Re-run SQL security/atomicity checks against the live schema after application, then perform a controlled test sale and cross-device check with user-approved test records. Commit, Push and Pages deployment each require the user's explicit direction and remote freshness check under `AGENTS.md`.
