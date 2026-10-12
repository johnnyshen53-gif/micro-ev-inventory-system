# 機車與電池序號管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 讓機車及電池逐件登錄原廠序號，於收貨、出庫、結帳及保固保持同一實物的追蹤關係。

**Architecture:** 沿用 Inventory 純函式與整份 state 驗證，新增 serials 實物清單，銷售及保固保存序號快照。沿用 IndexedDB 單筆交易保存所有相關變更；畫面不自行修改庫存，不新增同步後端。

**Tech Stack:** 原生 JavaScript／HTML／CSS、IndexedDB、Node.js node:test／vm；既有 Supabase 登入不變。

**Spec:** `docs/superpowers/specs/2026-10-11-serial-number-warranty-design.md`（使用者已確認）

## Global Constraints

- 機車與電池依分類強制序號管理，不另加可關閉的開關。
- 原廠序號全店不可重複，包含已售及已移出紀錄。保留大小寫與前導零，僅去除首尾空白；相同字串視為重複。
- 序號商品結帳必選客戶。有設定正整數保固月數才自動產生保固；月數為零仍保存客戶與銷售序號關聯。
- 既有庫存未全數補齊序號前，該品項暫停出貨，但其他品項仍可使用。
- 庫存調整移出的實物另外標記「已移出」，不冒充已售；移出須填原因。
- 舊銷售與舊保固不編造序號；localStorage 備援不刪除。匯入為整份還原，不合併。
- 不新增套件、IndexedDB store、Supabase 結構；不做換貨、退貨、重新入庫及跨電腦同步。
- 工作目錄沒有 Git repository，不初始化、不建立 worktree、不執行 commit；每項以測試結果作檢查點。
- 任務中間版本不交付使用；全套驗證完成後才請使用者重新整理。

## Review Focus

1. 舊備份的機車庫存若有小數：整份資料仍可讀，其他品項仍可操作；該品項必須由店長更正後才能補登／出貨。（Task 1、3、6）
2. 掃描器送出 Enter：序號登錄不誤送整張表單；字串 `000123` 不變成 `123`，不強制英數格式。（Task 1、6、7）
3. 同一序號跨品項或跨購物車列重複：不可依賴品項內去重，結帳再次拒絕，且不扣任何庫存。（Task 1、4、7）
4. 舊草稿收貨與等待儲存時重複按鈕：序號使用最後儲存草稿數量校驗，失敗保留輸入、成功不可再收貨。（Task 2、6、8）
5. 惡意或過時備份中的序號／銷售／保固關聯：拒絕矛盾的新資料，不拒絕沒有序號欄位的歷史紀錄。（Task 1、5、8）

## Files and interfaces

- Modify `inventory.js`：擴充既有模型與相關函式，不搬動無關模組。新 exports：`requiresSerial(item)`、`registerSerials(state, fields)`。
- Modify `app.js`、`index.html`、`style.css`：沿用現有頁面及事件模式，加入序號輸入、選擇及查詢，不新增獨立頁面或框架。
- Create `serials.test.js`：純函式資料完整性與出入庫回歸。
- Create `serial-ui.test.js`：依現有 VM DOM fixture 模式測試登錄、收貨、保固畫面。
- Modify `inventory.test.js`、`sales-picker.test.js`、`navigation.test.js`、`session-cleanup.test.js`、`storage.test.js`：更新機車／電池 fixtures，補結帳、權限、清理及回復測試；不得把全部測試品項改成用品來規避新規則。
- `storage.js`：原則上不改；由 round-trip／故障測試證明現有交易足夠。

## Task 1: 序號模型、舊資料相容及補登

**Files:** Modify `inventory.js`; Create `serials.test.js`; Modify `storage.test.js`.

**Interfaces:**
- `requiresSerial(item) -> boolean`：分類為機車或電池。
- `registerSerials(state, {itemId, serialNumbers: string[], createdBy}) -> nextState`：僅補登，不改庫存或異動數。
- `state.serials`：規格所列欄位；`status` 為 `in_stock`／`sold`／`removed`，未適用的可選欄位正規化為空字串。
- 保固新欄位 `serialId`／`serialNumber`；銷售新欄位 `serialIds`／`serialNumbers` 缺少時視為歷史空值，不改價格等舊欄位。

- [x] Step 1 — 撰寫失敗測試 `legacy state loads without invented serials`、`registration preserves stock and leading zeros`、`invalid serial relations reject atomically`：斷言 `validateState(old).serials.length === 0`、登錄 `[' 000123 ', '電池-A']` 後保存 `['000123','電池-A']`、庫存和 transactions 不變；重複 ID／空序號／數值型序號／跨品項同字串／不存在品項／不合法狀態均 throw。
- [x] Step 2 — 執行 `node --test serials.test.js`，確認新 API 或驗證缺失造成 FAIL。
- [x] Step 3 — 實作上述 exports、`normalizedSerial(value)` 及 `validateState` 關聯檢查；在庫數不得超庫存。舊小數庫存允許載入但補登拒絕；這是歷史相容例外，不放寬新操作。新序號只可連結序號商品；sold 的 saleId/customerId/數量及快照需互相一致，removed 需原因與操作者，不得同時有 saleId。保固 serialId 與字串必須成對。
- [x] Step 4 — 補測 `registration cannot exceed unregistered stock`：差額 2 可分兩次補登各 1、第三次拒絕；售出／移出序號不可重用。`storage.test.js` 測 serials 經保存讀回保留所有欄位；舊小數品項不阻擋另一個用品交易。
- [x] Step 5 — 執行 `node --test serials.test.js storage.test.js`，全部 PASS；記錄檢查點，不提交 Git。

## Task 2: 初始庫存與整張收貨

**Files:** Modify `inventory.js`, `serials.test.js`, `inventory.test.js`.

**Interfaces:**
- `addItem(state, {...existingFields, serialNumbers?: string[], createdBy?}) -> nextState`。
- `receivePurchase(state, purchaseId, {receivedBy, receivedByAccount, serialNumbersByItem?: {[itemId]: string[]}}) -> nextState`。
- 消費 Task 1 的 `requiresSerial` 與序號正規化／唯一性規則；共用內部實物建立邏輯，不透過補登 API 製造增量。

- [x] Step 1 — 撰寫失敗測試 `initial serialized stock requires matching numbers`：機車 stock 2 缺序號拒絕，兩個不同序號成功；零庫存不用序號，非序號品項不變。`whole receipt validates all serial lists before stock changes`：機車 2、電池 1、用品 3 混合草稿，序號少一個或跨項重複時整張拒絕，原 stock/cost/purchases/transactions/serials 不變。
- [x] Step 2 — 執行 `node --test serials.test.js`，確認 FAIL 後實作初始庫存及收貨 API。新數量限安全整數；收貨為每件建立 in_stock 紀錄，連結 purchaseId、操作者，沿用收貨成本、單號與異動處理；拒絕未知品項的輸入及非序號項目的非空序號清單。
- [x] Step 3 — 更新既有電池／機車新增與收貨測試 fixtures 提供正確序號，保留料號、品名、成本、保固月數等原斷言；補 `second receipt is rejected`、`saved draft quantity is authoritative`，重複收貨不建立第二份序號。
- [x] Step 4 — 執行 `node --test serials.test.js inventory.test.js`，全部 PASS。

## Task 3: 一般出入庫、盤點及品項編輯防繞過

**Files:** Modify `inventory.js`, `serials.test.js`, `inventory.test.js`.

**Interfaces:** `recordTransaction(state, {...existingFields, serialNumbers?: string[], serialIds?: string[], createdBy?}) -> nextState`；`type='out'` 對序號商品是移出，不是建立銷售。`updateItem` 不接受序號商品直接改 stock，盤點必須用 recordTransaction。

- [x] Step 1 — 撰寫失敗測試 `serialized movements preserve identified stock`：入庫 +2 要兩個序號；出庫 -1 必選該品項一個在庫 ID 且 note 非空；adjust 的 quantity 是目標庫存，增加須等量新序號，減少須選對移出序號。已售、已移出、錯品項、重複 ID 均拒絕，原 state 不變。
- [x] Step 2 — 執行 `node --test serials.test.js`，確認 FAIL 後實作。減少盤點規則：令 S=原庫存、I=在庫已登錄數、T=目標庫存、R=所選移出數；需 `0 <= R <= S-T` 且 `I-R <= T`，剩餘差額視為未識別庫存的更正。一般 out 一律要求完整補登及 `R=quantity`。舊小數 stock 僅准 adjust 到安全整數，依 `I-R <= T` 核對，不憑空新增實物；序號商品所有新 stock 限安全整數。
- [x] Step 3 — 測 `editing cannot bypass serial management`：有任何序號紀錄不能刪品項或改分類；序號商品不能直接改 stock。零件／用品改成序號分類時只能零庫存且無歷史交易／銷售／進貨／報價／保固關聯，否則要求另建品項，防止把舊分類追溯套用。舊小數庫存可盤點到整數且不低於已識別在庫數。
- [x] Step 4 — 執行 `node --test serials.test.js inventory.test.js`，全部 PASS。

## Task 4: 批次及單筆結帳的序號契約

**Files:** Modify `inventory.js`, `serials.test.js`, `inventory.test.js`.

**Interfaces:** `recordSaleBatch(state, {lines: [{itemId?, barcode?, quantity, serialIds?: string[]}], customerId?, createdBy?}) -> nextState`；`recordSale(state, fields)` 保留一般用品原格式，序號商品轉入同一批次驗證，不留略過路徑。

- [x] Step 1 — 撰寫失敗測試 `mixed checkout sells only specified physical units`：兩顆電池序號 A/B 與用品一起結帳，明細數量／金額正確，A/B 標 sold 連結對應 saleId、customerId、soldAt，未選 C 維持在庫；放入購物車之前的 state 不變。
- [x] Step 2 — 撰寫 `checkout rejects duplicate stale and missing serials`：缺客戶、序號數與 quantity 不符、跨列重複、錯品項、已售／移出、待補登／小數庫存全部拒絕。`recordSale` 同樣不能繞過；非序號商品非空 serialIds 拒絕。
- [x] Step 3 — 執行 `node --test serials.test.js` 確認 FAIL，實作同一批次結帳核心；先核對所有列、客戶及序號，再一次產生結果。每列保存 serialIds/serialNumbers 快照；不改既有單價／月報算法，結帳當下再次取現有售價。
- [x] Step 4 — 執行 `node --test serials.test.js inventory.test.js`，全部 PASS，保留一般條碼銷售及空條碼 itemId 選貨測試。

## Task 5: 逐件保固與維修追蹤

**Files:** Modify `inventory.js`, `serials.test.js`, `inventory.test.js`.

**Interfaces:** `createWarranty(state, {...existingFields, serialId?}) -> nextState`；`updateWarranty` 保護 serialId/serialNumber、來源及銷售關聯不被一般編輯覆蓋；`warrantiesForFilter` 新增序號搜尋。

- [x] Step 1 — 撰寫失敗測試 `two serials produce two warranties`：同列兩顆有 12 個月保固電池生成兩筆、各有正確序號且沿用購買日／月底算法。月數 0 不生成保固，但 serial 的 customerId/saleId 仍保存。
- [x] Step 2 — 撰寫 `manual serial warranty derives sold customer and rejects duplicates`：只接受已售實物，從售出紀錄取得 customer/item/sale 關聯；傳入不同客戶／品項拒絕，既有保固不可再建第二筆；未售實物拒絕。舊無序號保固可照常編輯／送修，搜尋 `000123` 找到對應保固。
- [x] Step 3 — 執行 `node --test serials.test.js` 確認 FAIL 後實作，保留零件／用品手動保固契約。validateState 拒絕重複序號保固及序號快照／客戶／銷售關聯矛盾，不要求歷史無序號保固補填。
- [x] Step 4 — 執行 `node --test serials.test.js inventory.test.js`，全部 PASS。

## Task 6: 店長序號清單、補登、收貨與異動畫面

**Files:** Modify `app.js`, `index.html`, `style.css`, `navigation.test.js`; Create `serial-ui.test.js`.

**Interfaces:** 使用 Task 1–3 的 Inventory APIs。新增 `renderSerialInventory()`、`renderPurchaseReceiptSerials(purchase)`、`renderTransactionSerials()`，用原生控制項。掃碼輸入為 text，逐行登錄；Enter 只新增一筆／換行並 preventDefault，不提交父表單。

- [x] Step 1 — 撰寫 VM DOM 失敗測試 `manager registers existing physical stock without increment`、`receipt inputs follow saved quantities`、`serial movement uses current signed-in operator`：登錄／收貨保存失敗保留輸入，未授權角色直接觸發 handler 也不能呼叫保存。
- [x] Step 2 — 執行 `node --test serial-ui.test.js` 確認 FAIL；加入庫存管理內序號面板：品項、庫存／已登錄／待補數、補登逐行輸入、搜尋及三種狀態清單。補登及調整要求 currentUser.role 為 admin，操作者取 currentUser.id；沿用目前進貨頁 admin 權限。
- [x] Step 3 — 新增初始庫存序號欄 `item-serial-numbers`；序號商品編輯時鎖住直接 stock 修改並指向盤點流程。一般異動新增新序號輸入／在庫序號多選／移出原因提示，依 type 顯示，呼叫 Task 3 API；不得在 UI 自行推算後直接覆寫 state。
- [x] Step 4 — 收貨按鈕先開啟最後儲存草稿的序號區，再確認整張收貨；購物車式序號草稿變數 `receiptSerialNumbersByItem` 保存到成功才清。cancel／切換單據有未存內容時確認；保留 purchaseBusy 及 pendingSave 防連按。
- [x] Step 5 — 測小數舊庫存提示、序號 `000123`、空輸入／重複序號錯誤、收貨重按、Enter 不誤提交及沒有序號品項照舊；執行 `node --test serial-ui.test.js navigation.test.js`，全部 PASS。

## Task 7: 銷售序號選擇及保固 UI

**Files:** Modify `app.js`, `index.html`, `style.css`, `sales-picker.test.js`, `serial-ui.test.js`, `navigation.test.js`.

**Interfaces:** `addSaleItem(item, quantity, serialIds = []) -> boolean`；`renderSaleSerialSelector(item)` 只顯示該品項未被購物車占用的在庫實物。購物車列沿用 itemId 聚合，但 serialIds/serialNumbers 也須合併且拒絕重複。

- [x] Step 1 — 撰寫失敗測試 `barcode and category flows share serial selection`：一般用品仍立即加入；機車／電池掃商品碼後先顯示序號選擇，不誤加未指定實物。序號碼在獨立輸入欄掃描，選到錯品項／已被占用時提示。
- [x] Step 2 — 執行 `node --test sales-picker.test.js serial-ui.test.js` 確認 FAIL，實作序號選擇、數量核對、購物車序號顯示；待補登品項阻擋加入並顯示待補數，購物車移除釋放選擇不改 stock。顯示在庫選項用 textContent，不把原廠序號拼入 HTML。
- [x] Step 3 — 測同一序號重複掃描、跨列重複、客戶未指定、已售序號及儲存失敗；結帳在呼叫 recordSaleBatch 前核對但不替代 domain 驗證。結帳成功才清除序號及商品草稿，失敗保留購物車。
- [x] Step 4 — 保固表單新增已售序號選擇 `warranty-serial`；選定帶入唯讀客戶／品項，呼叫 Task 5 API；詳情／列表顯示序號或「未登錄」，搜尋涵蓋序號。手動舊保固編輯不強制補登，維修仍按原 warrantyId。
- [x] Step 5 — 用原生 label/select/input、多選提示、aria-live 與手機單欄；測純鍵盤加入及選擇後結帳不受隱藏 required 欄位阻擋。執行 `node --test sales-picker.test.js serial-ui.test.js navigation.test.js`，全部 PASS。

## Task 8: 備份、登出清理與整體交付

**Files:** Modify `app.js`, `index.html`, `session-cleanup.test.js`, `storage.test.js`, `navigation.test.js`, `serial-ui.test.js`；僅必要時修改 `storage.js`。

**Interfaces:** `resetAppSession()` 清空新增銷售選擇、收貨草稿及序號列表；`setAppEnabled(false)` 鎖住新增輸入；新增 render 不可在登出後把控制項重新啟用。

- [x] Step 1 — 撰寫失敗測試 `logout clears serial selections while pending save cannot reenable app`、`legacy restore warns and cancellation preserves serials`、`failed serial checkout write keeps original persisted state`；匯入前備援仍先完成再寫入。
- [x] Step 2 — 執行 `node --test session-cleanup.test.js storage.test.js serial-ui.test.js` 確認 FAIL，補清理及匯入警告。匯入原始 JSON 缺 serials 而現有清單非空時，在既有確認中明示序號資料將被取代；不增加 silent merge。
- [x] Step 3 — 測完整 `toBackup -> validateState -> IndexedDB save/load`：在庫／已售／已移出序號、銷售快照、逐件保固、案件與供應商／進貨均保存；故障時不能留下僅 stock 減少或僅 serial 變 sold 的資料。
- [x] Step 4 — 更新 index 的 inventory.js/app.js/style.css 資源版本及相應 source assertions；執行 `node --check app.js`、`node --check inventory.js`、`node --test`，預期全部 exit 0，不以未設定 npm test 代替實際測試。
- [ ] Step 5 — 可用瀏覽器時用隔離測試資料操作「初始庫存／舊庫存補登 → 整張收貨 → 掃商品碼與序號／分類混合結帳 → 查保固 → 登出」。禁止用真實庫存試扣，不掃描或輸出登入密碼／token。若無可用隔離環境，明確記錄未做瀏覽器／硬體實測。
- [x] Step 6 — 獨立審查與一次修正完成；148 項測試通過。交付說明補登步驟、單分頁限制、備份及未測項目，不宣稱已有雲端共用庫存。

## Plan self-review

規格覆蓋：模型與舊資料 Task 1；初始／收貨 Task 2；一般異動與繞過防護 Task 3；結帳 Task 4；逐件保固 Task 5；管理與進貨 UI Task 6；銷售與保固 UI Task 7；備援／故障／登出 Task 8。五個 Review Focus 均已分派測試。新欄位及函式簽名在各任務一致；沒有資料庫／登入重構或額外模組。Task 1–5 是相依 domain 工作，不並行修改同一 inventory.js。

狀態：使用者已確認 Native，Task 1–8 功能、自動測試及獨立審查修正已完成；尚未實測瀏覽器與掃描槍。
