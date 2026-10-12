# SDD ledger — plan: docs/superpowers/plans/2026-10-11-serial-number-warranty.md

Native 已獲使用者確認，依序執行 Task 1–8，最後獨立審查。
Ruling: 此目錄非 Git repository，依已確認計畫使用本文件記錄檢查點，不執行依賴 Git 的 workspace/commit 腳本，不刪除記錄 — 無 Git 歷史時避免失去進度 — 成本：以測試及文件而非 commit 追蹤。
Pre-flight: Task 1 serials/registration -> Task 2 creation/receipt -> Task 3 movements，欄位及唯一性一致。
Pre-flight: Task 4 serialIds/sale snapshots -> Task 5 per-unit warranties -> Task 7 UI，簽名一致。
Pre-flight: Task 6 receiptSerialNumbersByItem -> Task 8 cleanup；Task 7 cart serialIds -> Task 8 persistence，需共同清除。
Ruling: 舊小數庫存可讀但禁止補登／售出，只准盤點更正為整數 — 規格明定舊資料可用 — 成本：店長需先核對數量。

Task 1: complete — RED→GREEN，node --test serials.test.js storage.test.js 9/9。
Task 2: complete — RED→GREEN，node --test serials.test.js inventory.test.js 52/52；更新原電池 fixtures，不改分類逃避驗證。
Task 3: complete — RED→GREEN，node --test serials.test.js inventory.test.js 54/54。
Task 4: complete — RED→GREEN，node --test serials.test.js inventory.test.js 55/55。
Task 5: complete — RED→GREEN，node --test serials.test.js inventory.test.js 57/57。
Task 6: complete — RED→GREEN，serial-ui.test.js + navigation.test.js 43/43；後續實際 app 收貨、異動與失敗恢復整合測試通過。
Task 7: complete — RED→GREEN，sales-picker.test.js + serial-ui.test.js + navigation.test.js 48/48；整合結帳失敗不扣庫存、兩件各建保固及清除未加入序號選擇均通過。
Task 8: complete — RED→GREEN，登出清理、舊備份警告與 IndexedDB 原子保存測試；node --test 146/146。
Final review: complete — 獨立 reviewer 檢查並通過 68 項針對性測試；無 Critical。Important：備份銷售識別／日期／收貨數量關聯、保固序號型別驗證，均補回歸測試 RED→GREEN。
Ruling: 將購物車移除後未立即釋放選項由 Minor 升為 Important — 規格明確要求可重新選取 — 已於同一次修正通過回歸測試。
Ruling: 不擴充跨分頁競態、雲端同步、退換貨或序號重新入庫 — 已確認範圍排除 — 成本：維持同一瀏覽器單一分頁使用。
Ruling: 不擴大驗證無序號舊銷售的日期／數量欄位 — 舊版資料相容；僅要求銷售 ID 非空且唯一，序號銷售日期一致 — 成本：舊資料仍可能不完整。
Final verification: node --test --test-reporter=dot 148/148 PASS；node --check app.js、inventory.js exit 0。單次最終修正後不重複啟動審查。尚未做實際瀏覽器與硬體掃描器測試；測試使用隔離記憶體資料，不動真實庫存。
