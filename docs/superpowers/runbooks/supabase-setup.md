# Supabase 多人版初始化

1. 已套用 `20261010000000_multiuser_inventory.sql`；所有公開資料表均啟用 RLS。
2. 在 Supabase Dashboard 的 **Authentication → Users** 建立 `johnnyshen53@gmail.com`，以正常的邀請或重設密碼流程設定密碼。不要將密碼交給任何人或寫入專案。
3. 帳號建立後，以專案管理工具將此使用者的 `profiles.role` 提升為 `admin`，再登入網頁。
4. 瀏覽器只可使用 publishable key；帳號建立、停用與重設密碼必須由受信任的 Edge Function 或 Supabase Dashboard 執行。

## 保固資料庫（20261010000003）

既有專案套用 `20261010000003_add_parts_warranties.sql`；新專案依序套用全部 migration。基礎 migration 也包含相同的保固結構，後續 migration 可安全重設同名政策與函式。不要在既有專案重跑整份基礎 migration。

專案 `uezwoxoikfeapkrekqzg` 已透過 migration 工具套用這份保固 SQL；雲端歷史版本為 `20261010040130`（`add_parts_warranties`），對應本機檔案 `20261010000003_add_parts_warranties.sql`。兩者是同一次結構變更的版本對應。日後使用 CLI 推送 migration 前，必須先核對並對齊本機與雲端 migration 歷史；目前資料庫已正確套用，不需要進行資料庫修復或重跑 migration。

商品的 `warranty_months` 預設為 `0`，舊銷售的 `customer_id` 為空，不回填歷史保固。未來雲端結帳使用 `create_sale(p_lines jsonb, p_customer_id uuid)`，未選客戶傳 `null`；既有單參數 RPC 仍可呼叫。每筆有保固月數的銷售明細建立一張保固，日期採台北結帳日及曆月加法，月底自動落在目的月份最後一天。保固保留客戶、商品、條碼與銷售識別快照，送修案件另保留建立時商品名稱及保固日期。

`warranties`、`warranty_cases` 明確授權 `authenticated` 讀取／新增／更新／刪除，並啟用 RLS。管理員與店員共用此資料庫角色：新增／讀取／更新要求 active staff，刪除政策只允許 active admin，並未授予店員有效刪除權。匿名與停用帳號無存取權。建立者須為登入者，更新不會改變建立者；商品仍只允許管理員變更。刪除保固會連帶刪除其案件，前端必須先確認。

以管理連線執行 `supabase/tests/multiuser_inventory.test.sql` 驗證結構、交易、店員限制及管理員刪除；所有測試帳號、商品與銷售都包在 transaction 並 rollback。套用後執行 Supabase security advisor；原有的 leaked-password protection 未啟用警示需由管理員另行評估 Auth 設定。

目前瀏覽器業務資料仍使用 IndexedDB；這份 migration 準備雲端介面，不會自動同步本機資料。

## 日後店員帳號

管理員只能透過受 JWT 保護的帳號管理端點建立、停用及重設店員帳號。停用時應同時禁止其 profile，並由 Auth 管理 API 撤銷工作階段。

## 帳號登入切換（已啟用）

店長指定帳號 `Johnny`，正規化後為 `johnny`；保留既有 UUID、密碼與 admin 角色。不要要求使用者在對話提供密碼，不得為了測試更動店長原密碼。

2026-10-11 店長本人回報驗證成功，`supabase-config.js` 的 `usernameLoginEnabled` 已設為 true，正式入口改用帳號登入。已部署 username_login（雲端版本 20261010231341）、staff-login v1（verify_jwt=false，帳號密碼驗證）及 staff-admin v2（verify_jwt=true，加上 live session/admin 驗證）；johnny 已連結原店長 UUID，密碼與角色未更動。

部署前：

1. 匯出營運備份，保留 IndexedDB/localStorage；讀取雲端 migration 歷史，不要直接 db push 全部舊 migration。新檔由 CLI 產生為 `20261010125025_username_login.sql`，部署時記錄其實際雲端版本。
2. 在測試環境跑 `supabase/tests/username_auth.test.sql` 與 `multiuser_inventory.test.sql`，兩份均 rollback。後者現在需要 auth.sessions fixture，供新版 session 撤銷檢查驗證；不要在正式資料庫模擬停用真實店長。
3. 本機可用暫存安裝的 PGlite 執行 `PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node supabase/tests/run-username-local.mjs supabase/migrations/20261010125025_username_login.sql`；這只證明 PostgreSQL 結構與 RLS，不代表真實 Auth 管理 API 已驗證。
4. Edge Functions 固定 SDK 2.117.3，保留 `deno.lock`；執行 `npx --yes deno@2.9.6 check --node-modules-dir=none supabase/functions/staff-login/index.ts supabase/functions/staff-admin/index.ts` 及相同 runtime 的 `test --node-modules-dir=none supabase/functions/staff-auth.test.ts`。
5. 核對現有 Auth schema：`auth.refresh_tokens.session_id` 應 ON DELETE CASCADE 至 auth.sessions。停用 RPC 只刪除目標的 sessions 並停用 profile；重設採 Auth admin password update（GoTrue UpdatePassword(nil) 會撤銷所有 sessions），禁止把 user UUID 當 admin.signOut 所需 JWT。
6. 使用 2026-10-11 已核准的帳號＋全站持久化限流，不讀取任何來源 IP 標頭，也不需要 `STAFF_TRUST_CF_IP`。每帳號每 15 分鐘最多 10 次失敗（進行中的驗證先預占）、全站每 15 分鐘最多 50 次請求；成功只釋放帳號預占，全站計數仍保留。超限 429；大量錯誤請求可讓所有人暫時無法登入，此風險已告知並取得同意。舊版 IP gate 不再適用。
7. 部署 schema 及兩支函式：staff-login 需要匿名可呼叫，因此 verify_jwt=false，但內部只以正確帳號密碼建立 session，並執行持久化限流；staff-admin verify_jwt=true 且內部驗證有效 JWT、live session 和 live active/admin。Secret/service role 僅留後端環境。關閉 Auth 公開自行註冊。
8. 使用專用測試帳號驗證錯誤密碼、併發建立重試、停用後舊 access/refresh token、重設後舊 session、限流及最後店長保護；記錄成功／失敗，不使用正式庫存試結帳。檢查安全 advisor。
9. 由受信任管理流程將店長既有 UUID 配對 johnny，不變更 Email/密碼。店長本人在隔離測試入口輸入原密碼驗證；不得在測試通過前將正式入口設 usernameLoginEnabled=true。正式切換後畫面不再接受 Email。
10. 更新腳本 cache 版本後重新整理，驗證五分鐘閒置、休眠、跨頁籤、刷新與儲存中的登出。清除未送出草稿，不刪除已儲存資料。若瀏覽器工具不允許 file URL，不繞過安全限制，改由使用者人工驗收。

回復：將 `usernameLoginEnabled` 回復 false 並回復已保留的舊版網頁入口；原 Auth UUID/密碼不變。不要回滾已完成的停用／重設，不刪除帳號對照、營運資料或原備援。若部署中有安全驗證失敗，明示未完成，不把僅本機測試通過稱為正式可用。

2026-10-11：三項審查問題已有本機回歸修正：重複建立不再停用已完成帳號、延遲登入不能解除登出、儲存失敗時的重新整理拒絕恢復。登出只移除 SDK 的認證鍵，並保留庫存與備份；分頁另保留 sessionStorage 鎖。IP 需求已由核准的全站限流替代。公開自行註冊已經使用者即時確認後在後台關閉；新 profiles 預設 inactive。店長原密碼、建立／重設／停用的真實 Auth 整合驗收仍待完成，正式開關保持 false。

最後驗收：以 Chrome 開啟根目錄 `verify-login.html`，由店長本人輸入原密碼。此頁不讀寫庫存、不儲存 token，會測試 staff-login 和受保護 staff-admin，再將測試 session 登出；顯示驗證成功後才允許正式切換。請勿在對話提供密碼。

Advisor 記錄：四張 app_private 表沒有 client policy 是預期的 deny-by-default；僅 service_role 存取。`current_staff_session_valid` 的 SECURITY DEFINER 警告為有意設計：只以驗證後的 auth.uid/session_id 回傳本人有效性布林值，不接受其他 user_id、不洩露對照。外洩密碼保護仍未啟用；評估方案限制後處理，不擅自升級付費方案。
