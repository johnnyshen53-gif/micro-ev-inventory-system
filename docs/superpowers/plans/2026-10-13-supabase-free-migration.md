# Supabase Free 多機資料移轉 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將品項、庫存、客戶與銷售的正式讀寫安全切換到 Supabase Free，並驗證手機與多台電腦共用資料。

**Architecture:** Supabase Postgres 是唯一權威資料來源；既有 IndexedDB 只保存已成功取得的快取與遷移前來源。`cloud-data.js` 將現有 state 與受 RLS 保護的資料表／RPC 互轉，前端只在雲端寫入成功後更新畫面及快取。

**Tech Stack:** Supabase Auth、Postgres、RLS、Edge Functions、SQL migrations、vanilla JavaScript、IndexedDB、Node.js built-in tests。

**Spec:** `docs/superpowers/specs/2026-10-13-supabase-free-migration-design.md`

## Global Constraints

- 使用現有 Supabase Free 專案；不升級付費方案、不設定自訂網域。
- 瀏覽器只可使用 publishable key 與登入工作階段；禁止提交 service-role、secret key、密碼、`.env` 或 JSON 客戶備份。
- IndexedDB 和匯出的來源 JSON 在驗證完成前必須保留，且移轉失敗不得覆蓋任何一方。
- 離線模式唯讀；不做寫入佇列、衝突合併或多店別。
- 供應商、採購、序號、保固與報價在雲端模式停用，直至其獨立的雲端 schema 與交易完成。
- 任何庫存扣減必須以一個受 RLS 保護的 Postgres RPC 重新檢查庫存，不能由前端決定可否扣減。
- 每個資料表須維持明確 grants 與 RLS；店員 API 回應不得含成本或稽核資料。

## Review Focus

- 同一 SKU 兩個裝置同時售出最後一件：僅一筆成功，庫存保持 0。
- 匯入 JSON 格式錯誤或中途失敗：雲端正式資料與本機來源都不被部分覆蓋。
- 已停用或已過期工作階段：不能讀取或寫入快取以外的雲端資料。
- 店員直接呼叫資料 API：不能取得成本、稽核紀錄或執行刪除／匯入。
- 網路中斷或 Free 專案暫停：畫面清楚標示唯讀，且所有寫入控制項不可使用。

---

### Task 1: 現有 Supabase Free 專案的唯讀盤點與安全基準

**Files:**
- Modify: `docs/superpowers/runbooks/supabase-setup.md`
- Test: `supabase/tests/multiuser_inventory.test.sql`

**Interfaces:**
- Consumes: `supabase-config.js` 的 project URL 與 browser-safe publishable key。
- Produces: 已確認的 migration／函式／RLS／grants 清單，以及可重複執行的安全檢查指令。

- [ ] **Step 1: 將 Free 專案連線、已套用 migration 與目前 schema 以唯讀方式記錄至 runbook**

不得記錄 secret key、存取權杖或客戶資料；若專案未連線、不是預期專案或 schema 不相符，停止並回報。

- [ ] **Step 2: 補上會失敗的 SQL 測試，涵蓋店員成本拒絕、停用帳號拒絕、原子庫存扣減與雲端備份權限**

在 `supabase/tests/multiuser_inventory.test.sql` 使用既有 test fixture 的 admin／clerk 情境，斷言資料庫而非前端負責拒絕。

- [ ] **Step 3: 執行 SQL 測試，確認新增斷言因未完成的雲端資料介面而失敗**

Run: `supabase/tests/run-username-local.mjs` 搭配專案既有 PGlite 設定。  
Expected: 新增的資料讀寫／匯入介面測試失敗，既有安全斷言不可退化。

- [ ] **Step 4: 僅在需要時，以 Supabase CLI 產生新 migration，補齊缺少的 schema、RLS、grants 或 RPC**

不得手寫 migration timestamp；只增加可由測試證明必要的差異，並在 SQL 中 revoke 預設 `PUBLIC` execute 權限。

- [ ] **Step 5: 執行資料庫測試與 security advisor**

Run: 專案 runbook 記錄的 SQL 測試與 `supabase db advisors`。  
Expected: 所有權限與併發庫存斷言通過，沒有新增未處理的 security finding。

### Task 2: 雲端 state 讀取、快取與受控寫入介面

**Files:**
- Create: `cloud-data.js`
- Create: `cloud-data.test.js`
- Modify: `index.html`
- Modify: `app.js`
- Modify: `storage.js`
- Modify: `storage.test.js`

**Interfaces:**
- Consumes: Task 1 的 Supabase schema/RPC 與 `window.AppAuth.requireActiveUser()`。
- Produces: `window.AppData.loadSnapshot(): Promise<{state, source:'cloud'|'cache', readonly:boolean}>`、`window.AppData.saveAction(action): Promise<state>`。

- [ ] **Step 1: 在 `cloud-data.test.js` 寫入失敗測試**

測試 `loadSnapshot` 將雲端資料組成 `Inventory.validateState` 接受的 state；網路錯誤只可回傳既有 cache 與 `readonly:true`；`saveAction` 失敗時不得更新 cache 或 UI state。

- [ ] **Step 2: 執行 focused test，確認因 `cloud-data.js` 不存在而失敗**

Run: `node --test cloud-data.test.js storage.test.js`  
Expected: FAIL，錯誤原因是 `window.AppData`／`cloud-data.js` 尚不存在。

- [ ] **Step 3: 實作 `cloud-data.js` 與最小 state mapping**

以登入者 session 呼叫受限 table queries／RPC；線上載入成功後才以 `InventoryStorage.saveState(state)` 更新快取。將每一個既有 mutation 映射為雲端 action，銷售必須呼叫既有 `public.create_sale` RPC，不可沿用 client-side 扣庫存。

- [ ] **Step 4: 改造 `app.js` bootstrap 與儲存呼叫點**

`bootstrap` 優先用 `AppData.loadSnapshot()`；所有 mutation 透過 `saveAction`，離線或 session 失效時禁用 mutation controls 並顯示繁體中文唯讀原因。

- [ ] **Step 5: 執行 focused tests，確認通過**

Run: `node --test cloud-data.test.js storage.test.js navigation.test.js && node --check cloud-data.js && node --check app.js`  
Expected: PASS，且測試證明失敗寫入不改 cache/state。

### Task 3: 管理員單次匯入與可復原遷移閘門

**Files:**
- Create: `migration-ui.js`
- Create: `migration-ui.test.js`
- Modify: `index.html`
- Modify: `app.js`
- Modify: `supabase/functions/staff-admin/index.ts`
- Modify: `supabase/functions/staff-runtime.test.ts`
- Modify: `docs/superpowers/runbooks/supabase-setup.md`

**Interfaces:**
- Consumes: Task 2 `AppData`、`Inventory.validateState(state)` 和已驗證的 admin session。
- Produces: `window.MigrationUI.exportLocalBackup()` 與 `window.MigrationUI.importSnapshot(file)`；後端 admin-only `import_inventory_snapshot` action。

- [ ] **Step 1: 寫入 migration UI 與 Edge Function 的失敗測試**

斷言店員看不到匯入操作；JSON 無法通過 `validateState` 時不呼叫網路；後端非 admin 回傳 403；後端匯入失敗時不替換既有 cloud snapshot。

- [ ] **Step 2: 執行 focused tests，確認因受控匯入流程不存在而失敗**

Run: `node --test migration-ui.test.js && deno test supabase/functions/staff-runtime.test.ts`  
Expected: FAIL，原因是 migration UI 與 server action 尚不存在。

- [ ] **Step 3: 實作先匯出、後驗證、再匯入的管理員流程**

前端先下載本機 JSON，再要求使用者選取該 JSON；本機 validation 成功才呼叫 Edge Function。伺服器端驗證 admin 與 schema，先寫入受 RLS 保護的 `cloud_backups`，再在單一資料庫交易寫入完整 snapshot；任何失敗皆回傳錯誤且不標示移轉完成。

- [ ] **Step 4: 執行 focused tests，確認通過**

Run: `node --test migration-ui.test.js && deno test supabase/functions/staff-runtime.test.ts`  
Expected: PASS，且所有失敗情境保留來源和既有雲端資料。

### Task 4: Free 方案上線驗證與多裝置 smoke test

**Files:**
- Modify: `docs/superpowers/runbooks/supabase-setup.md`
- Test: `cloud-data.test.js`, `migration-ui.test.js`, `supabase/tests/multiuser_inventory.test.sql`

**Interfaces:**
- Consumes: Task 1–3 的已部署 schema、Edge Function、前端與來源備份。
- Produces: 管理員可重複執行的驗證紀錄，包含匯入前後比對及三裝置驗證結果。

- [ ] **Step 1: 在 runbook 寫入不含敏感資料的正式驗證清單**

固定記錄來源 JSON 驗證、雲端筆數／關鍵庫存比對、admin／clerk 權限、Free 專案喚醒、手機與第二台電腦登入、以及可回復測試異動的步驟。

- [ ] **Step 2: 執行完整自動化驗證**

Run: `node --test`、Task 1 SQL 測試、Edge Function tests 與 Supabase security advisor。  
Expected: PASS；若既有不相關測試失敗，記錄檔名與錯誤，不宣稱全綠。

- [ ] **Step 3: 以管理員明確提供的來源備份執行一次遷移並比對結果**

只在使用者明確提供／授權來源資料後執行；比對 items、庫存、customers、sales、serials、warranties 與 warranty cases 的筆數及關鍵總數。

- [ ] **Step 4: 在來源電腦、手機與第二台電腦執行實機驗證**

各裝置用獨立帳號登入，確認資料一致；驗證一筆可逆操作與最後一件庫存的併發拒絕；完成後將測試資料回復或明確標記為測試資料。

- [ ] **Step 5: 只有在所有自動與實機驗證通過後，將雲端讀寫設為正式路徑**

保留 IndexedDB 和 JSON 備份，不刪除；若任何驗收失敗，恢復唯讀／本機備援模式並回報。
