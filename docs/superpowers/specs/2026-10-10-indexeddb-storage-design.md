# IndexedDB 儲存轉換設計

## 目標與範圍

將微型機車店庫存系統的唯一日常資料來源，從瀏覽器 `localStorage` 改為原生 IndexedDB。系統維持單一店員、單一電腦、離線使用與既有匯出／匯入備份流程。

首次使用新版時，系統自動將既有 `localStorage` 資料搬移到 IndexedDB。搬移成功後，舊資料保留但不再讀寫，作為人工回復備援。

不包含多裝置同步、登入帳號、雲端資料庫或資料結構重設計。

## 儲存架構

- 資料庫名稱：`motorcycleInventoryDB`。
- 資料庫版本：`1`。
- Object store：`state`，以固定鍵 `current` 儲存完整、已驗證的系統狀態。
- 狀態結構維持現有 `items`、`transactions`、`customers`、`salespeople`、`quotations`、`sales` 陣列，不改變業務函式介面。
- 新增 `storage.js`，提供 `loadState()` 與 `saveState(nextState)` 非同步 API；資料驗證仍使用 `window.Inventory.validateState`。

## 啟動與遷移流程

1. 開啟 IndexedDB，建立 `state` store（若尚不存在）。
2. 若 `state/current` 存在，驗證後作為系統狀態。
3. 若不存在，讀取既有 `localStorage.motorcycleInventory`：
   - 無舊資料時，使用空白狀態。
   - 有效舊資料時，驗證後寫入 IndexedDB，再顯示首次遷移完成訊息。
   - 無效舊資料或寫入失敗時，保留 `localStorage` 原文，不覆寫、不刪除，顯示可復原的錯誤訊息。
4. 遷移完成後，後續操作只讀寫 IndexedDB；舊 `localStorage` 不再同步。

## 寫入、匯入與錯誤處理

- `saveState` 先驗證，再使用一筆 IndexedDB read-write transaction 寫入完整狀態；交易完成後才回傳成功。
- 任一寫入失敗時，呼叫端不更新記憶體 `state`、不重新渲染成功狀態，改顯示錯誤。
- 所有品項、客戶、業務、報價、庫存異動、銷售與匯入操作改為等待儲存完成。
- 匯出從目前記憶體的已驗證狀態建立備份。
- 匯入前先匯出目前 IndexedDB 狀態作為保護備份，再驗證並寫入新資料；寫入失敗時舊 IndexedDB 資料保持不變。

## 使用者介面與相容性

- 應用程式在資料讀取完成前不開放資料操作，避免空白狀態覆蓋既有資料。
- 成功遷移使用既有狀態訊息區告知使用者。
- IndexedDB 依瀏覽器來源隔離；店內應固定以同一份網頁資料夾、同一個 Chrome 使用者設定檔開啟。
- 保留匯出備份提示，因瀏覽器資料不會跨裝置同步。

## 測試與驗證

- IndexedDB 空白時能遷移有效 `localStorage` 狀態，且保留舊鍵值。
- 已有 IndexedDB 狀態時，不重複讀取或遷移 `localStorage`。
- 無效舊資料與 IndexedDB 寫入失敗時，不刪除或覆寫 `localStorage`。
- `saveState` 寫入失敗時，不更換應用程式記憶體狀態。
- 匯入前建立保護備份且匯入失敗時保留原 IndexedDB 狀態。
- 所有既有業務規則測試繼續通過，並以瀏覽器手動驗證銷售、報價、匯出與重新載入。

## 接受條件

1. 首次新版啟動可安全搬移現有有效資料。
2. 之後的資料操作與重開頁面皆從 IndexedDB 讀寫。
3. `localStorage` 遷移來源保留不刪除。
4. 失敗不造成舊資料遺失或空狀態覆蓋。
5. 匯入／匯出與既有所有庫存業務功能維持可用。
