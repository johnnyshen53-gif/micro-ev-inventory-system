# 機車銷售獎金與維修分紅 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 結帳與維修完工時，在同一筆資料庫交易內寫入不可改的分紅快照；店長可設定與查看，一般員工看不到任何金額。

**Architecture:** 所有設定、名單與快照放在 `app_private` 結構（Data API 不公開），只能透過店長專用的 `public` 包裝 RPC 讀寫。機車獎金在既有 `create_sale_with_serials_logged` 內記帳；維修分紅以 `repair_orders` 狀態變成 `completed` 的 AFTER UPDATE 觸發器記帳，不改寫 90 行的 `complete_repair_order`。前端新增店長頁「分紅管理」（`bonus-ui.js`），維修單加「維修人員」必選欄位。

**Tech Stack:** Supabase Postgres（plpgsql、RLS、security definer）、原生 JavaScript、`node --test`、本機 Postgres 16 SQL 測試。

**Spec:** `docs/superpowers/specs/2026-10-17-sales-and-repair-bonus-design.md`

## 與規格不同的已確認決定

1. **成本已確認標記（2026-10-17 店長決定）**：`item_costs.cost` 是 `not null default 0`，無法分辨「沒填」與「真的 0 元」。新增 `item_costs.cost_confirmed boolean not null default false`。維修分紅百分比**已設定**時，維修單任一用料品項未確認成本即拒絕完工，訊息：「用料「X」成本尚未確認，請店長在分紅管理確認後再完工」。百分比未設定（功能未啟用）時不檢查，避免卡住現有流程。
   - 確認後若店長再改成本或進貨入庫改成本，標記維持「已確認」（由店長負責）；新品項預設未確認。
2. **機車獎金適用品項**在「分紅管理」頁以品項清單勾選（仍是逐品項標記），不放進品項表單，避免把店長資料混進一般品項儲存流程。
3. **新增 `bonus-ui.js`**（比照 `repair-ui.js`），規格列的檔案之外多一個前端檔。
4. **零元處理**：機車獎金金額為 0 時不寫紀錄（明確不發）；維修百分比已設定（含 0）時一律寫一筆維修快照（含淨額、成本明細），供店長核對，`bonus_amount` 可能為 0。

## Global Constraints

- 只在資料庫端計算與寫入；前端預覽不作記帳依據。
- 快照不可由 API 直接 insert/update/delete（`app_private` 表不授權給 `authenticated`）。
- 金額 `numeric(12,2)`；百分比 `numeric(5,2)` 介於 0～100；金額四捨五入至小數兩位。
- 不回算舊單：只有 migration 之後的結帳／完工才產生紀錄。
- 月份以 `Asia/Taipei` 的結帳時間（`sales.created_at`）／完工時間（`repair_orders.completed_at`）歸屬。
- 不修改 `docs/performance-audit.md`。
- 部署順序：先資料庫（fingerprint 核對 → `db push --dry-run` → `db push`），再合併前端。

## Review Focus

- 同一 checkout id 重送不重複記帳（既有提早 return 已涵蓋，需測試）。
- 一般員工直接呼叫 RPC 或 select 私有表一律失敗（42501 或無權限）。
- 改設定／名單／品項標記／成本後，舊快照不變。
- 沒有維修人員不能完工；停用的維修人員不能完工。
- 任一步失敗整筆回滾（例如成本未確認 → 庫存未扣、狀態未變）。
- 既有測試裡完工的維修單要補上維修人員 fixture，否則會失敗。

---

### Task 1：資料表與設定（migration `20261019010000_bonus_schema.sql`）

**Files:** Create `supabase/migrations/20261019010000_bonus_schema.sql`

- [ ] `public.repair_technicians(id uuid pk default gen_random_uuid(), name text not null check (length(trim(name))>0), active boolean not null default true, created_by uuid references public.profiles(id), created_at, updated_at)`；RLS：在職員工可 select；不授權 insert/update/delete（只能透過 RPC）。
- [ ] `alter table public.repair_orders add column technician_id uuid references public.repair_technicians(id)` ＋ 索引。
- [ ] `alter table public.item_costs add column cost_confirmed boolean not null default false`。
- [ ] `app_private.bonus_settings`（單列：`id boolean primary key default true check (id)`、`motorcycle_bonus_amount numeric(12,2) check (>=0)`、`repair_bonus_percent numeric(5,2) check (between 0 and 100)`，兩欄允許 null＝未設定、`updated_by`、`updated_at`）；先 insert 一列全 null。
- [ ] `app_private.motorcycle_bonus_recipients(salesperson_id uuid pk references public.salespeople)`。
- [ ] `app_private.motorcycle_bonus_items(item_id uuid pk references public.items)`。
- [ ] `app_private.sale_bonus_records(id, sale_id references public.sales, sale_number, salesperson_id, salesperson_name, units integer, unit_amount numeric(12,2), bonus_amount numeric(12,2), lines jsonb, occurred_at timestamptz, created_at)`，`unique (sale_id, salesperson_id)`，索引 `occurred_at`。
- [ ] `app_private.repair_bonus_records(repair_order_id uuid pk references public.repair_orders, repair_number, technician_id, technician_name, repair_total, parts_cost, net_amount, bonus_percent, bonus_amount, cost_lines jsonb, occurred_at, created_at)`，索引 `occurred_at`。
- [ ] 所有 `app_private` 新表：`revoke all ... from public, anon, authenticated`。

### Task 2：機車獎金記帳（migration `20261019020000_motorcycle_bonus.sql`）

**Files:** Create `supabase/migrations/20261019020000_motorcycle_bonus.sql`

- [ ] 新函式 `app_private.record_motorcycle_bonus(p_sale_id uuid)`：
  - 讀 `bonus_settings`；金額 null 或 0 → return。
  - 合計此單中屬於 `motorcycle_bonus_items` 的 `sale_lines.quantity` → `units`；0 → return。
  - 對 `motorcycle_bonus_recipients` join `salespeople where active`，每人 insert 一列（`bonus_amount = round(units * amount, 2)`、`lines` 存品項名稱與數量、`occurred_at = sales.created_at`）。
- [ ] 複製 **20261017090000** 的 `app_private.create_sale_with_serials_logged` 全文，只在寫完 `sale_salesperson_attributions` 後加 `perform app_private.record_motorcycle_bonus(v_sale_id);`。
- [ ] 部署前核對正式環境 `md5(prosrc)` 與 repo 中 20261017090000 版本一致。

### Task 3：維修人員與維修分紅（migration `20261019030000_repair_bonus.sql`）

**Files:** Create `supabase/migrations/20261019030000_repair_bonus.sql`

- [ ] 複製 **20261018010000** 的 `app_private.save_repair_order` 全文，加入 `technicianId`：可空白（儲存時不強制）；有值時必須是在職維修人員（編輯時沿用原本的人則不檢查在職）；寫入 `technician_id`。
- [ ] 觸發器函式 `app_private.record_repair_bonus()`（security definer），`after update on public.repair_orders for each row when (old.status <> 'completed' and new.status = 'completed')`：
  1. `technician_id` 為 null → raise「請先指定維修人員再確認完工」；人員已停用 → raise「維修人員已停用，請重新指定」。
  2. 讀 `repair_bonus_percent`；null → return（不記帳）。
  3. 逐行 join `item_costs`：無資料列或 `cost_confirmed = false` → raise 上方訊息；`parts_cost = sum(quantity * cost)`；`cost_lines` 存品項、數量、單位成本。
  4. `net = greatest(new.total - parts_cost, 0)`；`bonus = round(net * percent / 100, 2)`；insert 一筆（`occurred_at = new.completed_at`）。
- [ ] 因為觸發器在同一筆交易中執行，raise 會讓扣庫存、保固、狀態全部回滾。

### Task 4：店長 RPC（migration `20261019040000_bonus_admin_rpc.sql`）

每個都是 `app_private` security definer ＋ `public` security invoker 包裝；開頭 `if not app_private.is_admin() then raise ... using errcode='42501'`；只 grant 給 `authenticated`。

- [ ] `get_bonus_admin_state() returns jsonb`：設定、受領名單、適用品項 id、可當用料品項（零件／用品／電池）的成本與確認狀態、全部維修人員。
- [ ] `save_bonus_settings(p_motorcycle_amount numeric, p_repair_percent numeric, p_recipient_ids uuid[], p_motorcycle_item_ids uuid[])`：整批取代名單與品項；寫 audit log。
- [ ] `set_item_costs_confirmed(p_item_ids uuid[], p_confirmed boolean)`。
- [ ] `save_repair_technician(p_id uuid, p_name text, p_active boolean) returns uuid`（p_id null＝新增）。
- [ ] `get_monthly_bonus_report(p_month text) returns table(kind text, person_id uuid, person_name text, source_number text, occurred_at timestamptz, base_amount numeric, bonus_amount numeric)`：union 兩種快照，依台灣時間月份篩選。

### Task 5：SQL 測試

**Files:** Create `supabase/tests/bonus.test.sql`、`supabase/tests/run-bonus-local.mjs`；Modify `supabase/tests/repair_orders.test.sql`、`supabase/tests/repair_salesperson.test.sql`（完工前補維修人員 fixture）

- [ ] 機車：每台乘數（數量 2 × 名單 3 人 → 3 列，每列 2 × 金額）；金額未設定／0／名單空 → 0 列；同 checkout 重送 → 不增加；停用業務員不受領；改金額後舊列不變；非標記品項不計。
- [ ] 維修：無維修人員拒絕完工且庫存未扣；停用人員拒絕；成本未確認拒絕；淨額為負 → bonus 0；百分比未設定 → 無紀錄但可完工；改百分比／成本後舊紀錄不變。
- [ ] 權限：一般員工呼叫 4 個店長 RPC 皆 42501；`select` 私有表失敗。
- [ ] 用本機 Postgres 16 跑全部 runner（含既有）。

### Task 6：前端資料層（`cloud-data.js`）

- [ ] 維修查詢加 `technician_id` → `technicianId`；`loadRepairOrders` 一併讀 `repair_technicians`（id、name、active）。
- [ ] `saveRepairOrder` 傳 `technicianId`。
- [ ] 新增 `loadBonusAdminState`、`saveBonusSettings`、`setItemCostsConfirmed`、`saveRepairTechnician`、`loadMonthlyBonusReport`。
- [ ] 測試：`cloud-data.test.js` 各 RPC 名稱與參數對應。

### Task 7：維修單畫面（`repair-ui.js`、`index.html`）

- [ ] 表單加 `#repair-technician` 選單（在職維修人員；編輯中若原人員已停用仍列出）。
- [ ] 明細顯示「維修人員：」；未指定時「確認完工並扣料」按鈕旁提示「請先指定維修人員」，不送出。
- [ ] 測試：`repair-ui.test.js` 未指定時不呼叫 `completeRepairOrder`。

### Task 8：分紅管理頁（`bonus-ui.js`、`index.html`、`app.js`、`style.css`）

- [ ] 頂欄新增 `data-page-target="bonus" data-role="admin"`「分紅管理」。
- [ ] 區塊：①設定（每台機車獎金、維修分紅 %，空白顯示「未設定（不記帳）」）②受領業務員勾選 ③機車獎金適用品項勾選 ④用料成本確認表 ⑤維修人員名單（新增／停用）⑥月份報表（個人合計＋明細、原始單號）。
- [ ] 一般員工：分頁不顯示，`bonus-ui` 不呼叫任何 RPC。
- [ ] 快取版本：`index.html` 各檔 `?v=` 加 1，並同步 `navigation.test.js` 釘選的版本。
- [ ] 測試：新增 `bonus-ui.test.js`（未設定狀態文字、送出參數、員工不載入）。

### Task 9：驗證與部署

- [ ] `node --test` 全過；所有 SQL runner 全過；Playwright 截圖分紅頁與維修單。
- [ ] 正式環境核對 `save_repair_order`、`create_sale_with_serials_logged` 的 md5 指紋。
- [ ] `supabase db push --dry-run` → 使用者確認 → `supabase db push`。
- [ ] 資料庫上線後才合併前端 PR；合併前不宣稱正式站已啟用。
- [ ] 上線後提醒店長：設定金額／百分比、勾選名單與品項、確認用料成本、建立維修人員；進行中的維修單需先補維修人員才能完工。
