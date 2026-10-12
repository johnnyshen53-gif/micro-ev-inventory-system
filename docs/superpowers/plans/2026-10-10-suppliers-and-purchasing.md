# 供應商與進貨管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加供應商管理、單一供應商品項關聯、整張進貨收貨與付款標記，保留舊資料和歷史快照。

**Architecture:** 沿用 `window.Inventory` 純函式產生下一份狀態、`app.js` 操作畫面及 IndexedDB 整份交易寫入。供應商、進貨單納入既有正規化及 JSON 備份，不引入套件、後端或重構原有模組。六個相依任務順序完成，每項先寫失敗測試。

**Tech Stack:** 原生 HTML／CSS／JavaScript、IndexedDB、Node.js `node:test`／`vm`。

**Spec:** `docs/superpowers/specs/2026-10-10-suppliers-and-purchasing-design.md`（已確認）。

## Global Constraints

- 只有店長可操作新增模組；本機角色檢查不是伺服器安全邊界。
- 資料只存目前瀏覽器 IndexedDB；不修改 Supabase、不新增雲端同步。
- 每個品項僅一個供應商；舊品項 `supplierId` 預設空字串。
- 草稿不改庫存；整張收貨一次入庫並更新成本，不分批收貨。
- 付款只有未付款／已付款，不分次付款，不撤銷已付款。
- 供應商只停用不刪除；已收貨單不可修改或刪除。
- 金額最多兩位小數，以安全整數分計算；數量為正整數。
- 不更動售價、料號、條碼、歷史銷售成本、報價或保固快照。
- 舊備份匯入為整份取代，不自動合併；匯入前保留保護備份。
- 使用 `apply_patch` 編輯。此目錄不是 Git repository，不能建立 worktree 或 commit；每任務記錄測試結果，不初始化 Git。

## Review Focus

1. 舊備份的新增陣列缺失與明確填入錯誤型別不同：前者補預設，後者拒絕（Task 1／6）。
2. 供應商改派或停用發生於草稿儲存之後：改派阻止收貨，停用仍可完成既有草稿（Task 2／3）。
3. 小數與超大數字不可產生浮點錯帳或非有限庫存（Task 2／3）。
4. 按鈕重複點擊、寫入失敗及登入角色變更不可造成重複入庫或錯誤成功訊息（Task 5／6）。
5. 重新 render 或切換供應商時不可悄悄遺失草稿明細、選取值或清空未確認資料（Task 4／5）。

## File Map

- `inventory.js`：狀態結構、驗證、供應商與進貨純函式、刪除保護、匯出。
- `inventory.test.js`：領域操作與舊功能回歸測試。
- `index.html`：新增分頁、表單及腳本快取版本。
- `app.js`：供應商與進貨畫面、事件、角色限制、儲存後才更新 UI。
- `style.css`：沿用現有樣式，只補進貨明細所需排版。
- `navigation.test.js`：沿用現有 VM 操作方式，新增可執行事件測試，不只檢查原始碼文字。
- `storage.test.js`：新增資料的持久化、失敗保存與備份相容性；除非測試證明必要，不改 `storage.js`。
- 本計畫：逐項勾選及記錄驗證；不建立無用途的共用框架。

## Task 1: 供應商資料與單一供應商關聯

**Files:** Modify `inventory.js`; Test `inventory.test.js`。

**Interfaces:**
- Consumes: `validateState(value) -> State`、`addItem(state, fields) -> State`、`updateItem(state, itemId, fields) -> State`。
- Produces: `State.suppliers`、`State.purchases`（先空陣列）、`Item.supplierId`；`addSupplier(state, fields) -> State`、`updateSupplier(state, supplierId, fields) -> State`、`deactivateSupplier(state, supplierId) -> State`，皆匯出至 `window.Inventory`。
- `fields`：`name, contact, phone, address, taxId, note`；操作內產生 ID、時間及啟用狀態，更新不得竄改原 ID／建立時間。

- [x] **Step 1 — 寫失敗測試。** 增加供應商建立／編輯／停用、空白名稱、非 8 碼統編、重複 ID、外鍵不存在、停用供應商不得新指派；未更動的舊停用關聯可儲存。以下核心斷言放入測試：

```js
const state = addSupplier(emptyState(), { name: '電池供應商', taxId: '12345678' });
assert.equal(state.suppliers[0].active, true);
assert.equal(validateState({ items: [], transactions: [] }).suppliers.length, 0);
assert.throws(() => validateState({ items: [], transactions: [], suppliers: {} }));
```

- [x] **Step 2 — 執行 `node --test inventory.test.js`。** 確認因缺少供應商功能而 FAIL，不是測試語法錯誤。
- [x] **Step 3 — 實作上述介面。** 根狀態預設新增兩陣列；先驗供應商再驗品項；新增與更新處理選擇啟用供應商的限制，載入資料則允許保留停用關聯。不更動電池命名及料號生成。
- [x] **Step 4 — 執行 `node --test`。** 全套 PASS，記錄數量與結果後勾選本任務；無 Git commit。

## Task 2: 進貨草稿、金額與快照

**Files:** Modify `inventory.js`; Test `inventory.test.js`。

**Interfaces:**
- Consumes: Task 1 的供應商／品項關聯與 `validateState`。
- Produces: `createPurchase(state, fields) -> State`、`updatePurchase(state, purchaseId, fields) -> State`、`deletePurchase(state, purchaseId) -> State`。
- `fields`：`supplierId, lines: [{ itemId, quantity, unitCost }], note, createdBy`。更新保留原建立者／時間／單號，忽略輸入的狀態和付款欄位。
- `Purchase` 完整欄位及快照採規格命名；`status: 'draft'`、`paymentStatus: 'unpaid'`，未發生的時間與操作者為空字串。新單號為台北日期 `PYYYYMMDDNNN`，每日最大序號加一、上限 999。

- [x] **Step 1 — 寫失敗測試。** 草稿兩項例如 `quantity: 3, unitCost: 0.1` 與 `quantity: 2, unitCost: 1.25`，斷言 `total === 2.8`、庫存／成本／異動未改；空明細、重複 itemId、錯誤供應商、零數量、三位小數、Infinity、超安全整數拒絕。補快照更新、來源改名不回寫舊單、刪除草稿及同日序號溢位測試。
- [x] **Step 2 — 執行 `node --test inventory.test.js`，確認新增測試 FAIL。**
- [x] **Step 3 — 實作草稿與金額驗證。** 用整數分計算並存回數值金額；不要只驗算術合計而略過小數精度。停用供應商不能建立新單，但已有單允許編輯／完成；改派品項須在更新時拒絕。`validateState` 嚴格驗證 purchases 型別、ID／單號唯一性、外鍵、快照、狀態、時間及總額；載入舊單不以目前供應商關聯推翻歷史。
- [x] **Step 4 — 執行 `node --test`，確認全套 PASS，記錄結果。**

## Task 3: 整張收貨、付款與刪除保護

**Files:** Modify `inventory.js`; Test `inventory.test.js`。

**Interfaces:**
- Consumes: Task 2 的進貨單結構與草稿介面。
- Produces: `receivePurchase(state, purchaseId, { receivedBy }) -> State`、`markPurchasePaid(state, purchaseId, { paidBy }) -> State`。
- `Transaction.purchaseId` 為可選關聯，舊異動預設空字串；有值須引用已收貨進貨單。`deleteItem` 對任何進貨單引用拒絕刪除。

- [x] **Step 1 — 寫失敗測試。** 兩品項一次收貨後斷言各自庫存相加、成本等於各明細單價、售價／SKU／條碼未改、兩筆 `in` 異動含單號與 purchaseId，單據為 received。二次收貨、其中一項改派／不存在、庫存加總溢位全部拒絕且輸入 state 不變。停用後舊草稿可收貨；付款前提、重複付款拒絕、付款不改庫存與成本、收貨與付款操作者／時間須正確。補有進貨引用的品項不可刪除、已收貨不可改刪及歷史銷售快照不變。
- [x] **Step 2 — 執行 `node --test inventory.test.js`，確認新增測試 FAIL。**
- [x] **Step 3 — 實作狀態轉換。** 收貨前驗整張單後才建立一次下一狀態，不逐筆持久化。一次輸出新單、庫存及異動，再統一 validate；不得透過 recordTransaction 多次儲存。付款限 received/unpaid，設定 paid 時間與操作者，不產生金流。正規化防止 unpaid 搭配 paidAt 或 draft 搭配收貨／付款時間等不一致組合。
- [x] **Step 4 — 執行 `node --test`，確認全套 PASS，記錄結果。**

## Task 4: 供應商畫面與品項選擇

**Files:** Modify `index.html`, `app.js`, 必要的 `style.css`; Test `navigation.test.js`。

**Interfaces:**
- Consumes: Task 1 匯出介面與現有 `saveState(nextState) -> Promise<boolean>`。
- Produces: `renderSuppliers()`、`renderItemSuppliers()`，納入 `render()`；`itemFields()` 帶入 supplierId，reset／startEditing 正確處理。
- UI IDs：`supplier-form`, `supplier-id`, `supplier-name`, `supplier-contact`, `supplier-phone`, `supplier-address`, `supplier-tax-id`, `supplier-note`, `supplier-form-error`, `supplier-cancel`, `supplier-search`, `supplier-status-filter`, `supplier-list`, `item-supplier`。分頁 key `suppliers`。

- [x] **Step 1 — 寫失敗 VM 事件測試。** 驗新增／更新／停用與搜尋、店員直接觸發 submit/click 不會呼叫儲存、render 保留供應商選值、編輯既有停用關聯仍可見且不供新選取。用現有 navigation VM 測試風格與最少 DOM double，斷言實際表單／資料行為，不只源碼匹配。
- [x] **Step 2 — 執行 `node --test navigation.test.js`，確認新行為 FAIL。**
- [x] **Step 3 — 實作 UI。** 新 tab/section 設 `data-role="admin"` 並在每個 mutation 事件檢查角色；供應商名稱用 textContent。復用既有錯誤呈現、表格、確認停用及儲存成功後 render。庫存清單增加供應商名稱但不顯示成本；更新 colspan。供應商切換／render 不重設其他品項表單欄位。
- [x] **Step 4 — 執行 `node --test`，確認全套 PASS，記錄結果。**

## Task 5: 進貨畫面與收貨／付款操作

**Files:** Modify `index.html`, `app.js`, 必要的 `style.css`; Test `navigation.test.js`。

**Interfaces:**
- Consumes: Tasks 2／3 所有進貨函式、`currentUser`、`saveState`。
- Produces: `renderPurchases()`、`renderPurchaseBuilder()`，納入 `render()`；本地 UI 變數 `purchaseLines`、`selectedPurchaseId`，不寫入未儲存資料。
- UI IDs：`purchase-form`, `purchase-id`, `purchase-supplier`, `purchase-item`, `purchase-quantity`, `purchase-unit-cost`, `purchase-add-line`, `purchase-lines`, `purchase-total`, `purchase-note`, `purchase-form-error`, `purchase-cancel`, `purchase-search`, `purchase-status-filter`, `purchase-payment-filter`, `purchase-list`, `purchase-detail`。分頁 key `purchases`。

- [x] **Step 1 — 寫失敗事件測試。** 新單加入兩品項、移除／編輯數量單價、重複加入提示；切換供應商取消保留明細，確認才清空；render／頁面切換不丟編輯資料。收貨取消不儲存、接受後只 saveState 一次；pending 期間再次點擊不收貨；未收貨不顯示付款操作、收貨後不可改刪；所有 mutation 非店長拒絕。
- [x] **Step 2 — 執行 `node --test navigation.test.js`，確認新增測試 FAIL。**
- [x] **Step 3 — 實作表單與明細。** 供應商選項只供新單選啟用者，舊單可顯示停用選項。品項依供應商過濾，單價帶成本（超兩位小數明確四捨五入）。草稿儲存、刪除、收貨、付款均走 saveState，成功才清理本地編輯資料／顯示訊息；失敗保留表單。各 mutation 在 await 前設本地 busy guard，finally 清除，避免程式直接重觸發事件繞過 disabled。
- [x] **Step 4 — 加入完整列表與明細。** 快照顯示、搜尋／篩選、收貨前供應商／總數／總額確認、付款確認、只讀收貨紀錄及無撤銷的明確提示。updatedAt／操作人來自領域操作與 currentUser，不可讓表單自行填。
- [x] **Step 5 — 執行 `node --test`，確認全套 PASS，記錄結果。**

## Task 6: 備份、持久化與整體驗收

**Files:** Test `inventory.test.js`, `storage.test.js`, `navigation.test.js`; Modify `app.js`, `index.html` 及僅測試需要時的 `storage.js`。

**Interfaces:**
- Consumes: Tasks 1–5、`toBackup(state)`、`InventoryStorage.loadState()`／`saveState(nextState)`。
- Produces: 新模組完整 JSON／IndexedDB 往返、舊備份警告、更新後前端腳本版本及驗收記錄。

- [x] **Step 1 — 寫失敗整合測試。** 建供應商／品項／草稿→收貨→付款→JSON 往返，斷言 supplierId、快照、purchaseId、時間及操作者保留。舊資料缺陣列補空；明確非陣列、重複 ID、非法關聯、偽造合計／狀態一律拒絕。IndexedDB 寫入失敗保留已存狀態；app 不更新 state、不報收貨成功且保留草稿，復原後可完成一次收貨。舊備份替換前明確警告新模組資料會清空，取消則不寫入。
- [x] **Step 2 — 執行 `node --test`，確認新增行為 FAIL。**
- [x] **Step 3 — 完成必要整合與備份警告。** 保留匯入前保護備份；不要為新欄位增加 IndexedDB schema/store/version。更新 inventory.js/app.js 快取版本與原有導覽測試的對應期望。
- [x] **Step 4 — 執行 `node --test`、`node --check inventory.js`、`node --check app.js`、`node --check storage.js`，全部 exit 0。** 檢查供應商／進貨沒有漏掉 callers、exports、reset、render、測試 fixtures。
- [x] **Step 5 — 若可用，於安全測試環境做瀏覽器驗收。** 不寫入使用者真實庫存或雲端資料；驗證分頁、供應商指派、多項草稿、確認收貨／付款、刷新保存及店員限制。遇 file URL 安全政策不得繞過，記錄未驗證項目。
- [x] **Step 6 — 依選定執行技能完成整體審查與修正。** 不主動提交、部署或修改雲端；交付摘要包含測試結果、實測限制，以及本機角色非安全授權／多分頁覆寫／無收貨撤銷的限制。

## 自我審閱與交接

規格各節覆蓋：供應商／關聯→Task 1／4，草稿／金額／快照→Task 2／5，收貨／付款／刪除→Task 3／5，相容性／備份→Task 1／6，UI 與角色→Task 4／5。五項 Review Focus 均在對應任務具體測試中列出，介面命名一致。

使用者已選 Native，六項任務完成。獨立唯讀審查後修正金額精度、十進位四捨五入及僅備註未儲存保護；最終 `node --test` 為 95/95，三個 JavaScript 語法檢查通過。未實際操作瀏覽器、真實庫存或雲端，詳細驗證與限制見 `.superpowers/sdd/2026-10-10-suppliers-and-purchasing/progress.md`。
