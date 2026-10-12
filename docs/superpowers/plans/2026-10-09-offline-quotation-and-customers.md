# 單頁客戶與報價系統 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將離線庫存系統整合成單一網頁，提供客戶維護、報價與列印。

**Architecture:** `index.html` 是唯一入口，以原生 button 頁籤和 `hidden` 切換庫存清單、庫存管理、客戶管理與報價單。`inventory.js` 驗證所有 LocalStorage 狀態與不可變更新；`app.js` 依目前頁籤渲染；列印由報價詳情和 `@media print` 完成。

**Tech Stack:** 原生 HTML、CSS、JavaScript、LocalStorage、Node.js `node:test`、瀏覽器原生列印。

**Spec:** `docs/superpowers/specs/2026-10-09-offline-quotation-and-customers-design.md`

## Global Constraints

- 完全離線、單一瀏覽器資料庫，且只操作 `index.html`。
- 不新增套件、伺服器、雲端或 ES modules。
- 報價使用標準售價快照、不扣庫存，不提供改價、折扣、稅金或轉售出。
- 客戶姓名與電話必填；舊備份缺少新欄位時補空陣列。

## Review Focus

- 頁籤切換後只能看見目標內容，且能返回庫存清單。
- 品項售價或客戶資料改變後，歷史報價快照不變。
- 報價數量超過庫存時，庫存與異動紀錄不變。
- 列印只顯示報價單，不顯示導覽或控制項。
- 匯出／匯入同時保存庫存、客戶與報價。

## File Structure

- Modify: `inventory.js`, `inventory.test.js` — 客戶／報價資料模型、備份與 TDD。
- Modify: `index.html` — 唯一入口、四頁籤、客戶和報價 DOM。
- Modify: `app.js`, `style.css` — 頁籤、互動、明細與列印。
- Modify: `navigation.test.js` — 單頁結構和 classic script 檢查。

### Task 1: 資料模型與備份

**Files:** `inventory.js`, `inventory.test.js`

**Interfaces:** `State = { items, transactions, customers, quotations }`; `addCustomer(state, fields)`, `updateCustomer(state, id, fields)`, `deactivateCustomer(state, id)`, `createQuotation(state, fields)`。

- [ ] 寫失敗測試：客戶必填、停用客戶拒絕報價、價格快照、報價不扣庫存、舊備份相容、被引用品項不能刪除。
- [ ] Run: `node --test inventory.test.js`，Expected: FAIL，原因為新 API／狀態尚未完成。
- [ ] 實作正規化與不可變 API；報價編號固定 `YYYYMMDD-001`；所有儲存經 `validateState`。
- [ ] Run: `node --test inventory.test.js`，Expected: PASS。

### Task 2: 單一入口與頁籤結構

**Files:** `index.html`, `navigation.test.js`

**Interfaces:** `data-page-target` 和 `data-page` 都使用 `list`、`manage`、`customers`、`quotations`。

- [ ] 寫失敗靜態測試：`index.html` 有四頁籤、四內容區塊、客戶表單／表格、報價表單／明細／紀錄／列印按鈕，以及 classic scripts。
- [ ] Run: `node --test navigation.test.js`，Expected: FAIL，因為客戶或報價區塊缺失。
- [ ] 擴充 `index.html`，保留既有清單與管理區塊，加入客戶和報價區塊；初始只顯示清單頁籤，所有欄位有 label 與錯誤區。
- [ ] Run: `node --test navigation.test.js`，Expected: PASS。

### Task 3: 單頁互動與列印

**Files:** `app.js`, `style.css`, `navigation.test.js`

**Interfaces:** `showPage(page)`；`renderCustomers()`；以記憶體暫存尚未儲存的報價明細；`renderQuotations()`。

- [ ] 寫會失敗的最小測試：頁籤目標、報價列印區與必要 DOM 存在；真實資料層 API 已由 Task 1 覆蓋，不寫 mock 行為斷言。
- [ ] Run: `node --test`，Expected: FAIL，直到單頁客戶／報價 DOM 完成。
- [ ] 實作四頁籤切換、客戶新增／編輯／搜尋／停用；每個事件以元素存在與否為 guard。
- [ ] 實作報價暫存明細、建立、搜尋、詳情和 `window.print()`；只呼叫 `createQuotation`，絕不呼叫 `recordTransaction`。
- [ ] 加入最小 CSS 與 `@media print`，只印出報價詳情。
- [ ] Run: `node --test && node --check app.js && node --check inventory.js`，Expected: PASS。

### Task 4: 手動回歸

**Files:** `app.js`, `style.css`（僅發現問題才修改）

- [ ] 在 Chrome 以 `file://` 開啟 `index.html`，依序切換四頁籤、建立客戶、建立兩筆明細報價、查看／列印、再測條碼異動。
- [ ] 匯出含報價資料的 JSON，確認匯入不會覆蓋資料直到使用者確認。
- [ ] Run: `node --test && node --check app.js && node --check inventory.js`，Expected: PASS。
