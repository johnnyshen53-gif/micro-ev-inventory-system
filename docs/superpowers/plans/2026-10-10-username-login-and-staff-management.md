# 帳號登入與店長帳號管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全員改用帳號密碼登入，只有店長可管理業務員登入身分，並加入五分鐘閒置登出。

**Architecture:** 沿用 Supabase Auth 與 profiles，新增私有帳號對照、公開登入 Edge Function 及受 JWT 保護的店長管理介面。登入端點在伺服器解析帳號，以一般 Auth 密碼流程驗證；本機營運資料仍存 IndexedDB，不聲稱完成雲端同步或本機資料隔離。

**Tech Stack:** 原生 JavaScript、HTML/CSS、Node test runner、Supabase PostgreSQL/RLS、Deno Edge Functions；Supabase SDK 在 Edge Function 固定已驗證版本，不新增前端框架。

**Spec:** `docs/superpowers/specs/2026-10-10-username-login-and-staff-management-design.md`

## Global Constraints

- 帳號採 3–32 字元，英文字母、數字、底線與連字號；去除首尾空白後轉小寫，大小寫視為同一帳號。
- 密碼至少 12 字元並符合專案 Auth 政策；不自行存放明文或自訂雜湊。
- 每帳號每 15 分鐘最多 10 次失敗、全站每 15 分鐘最多 50 次登入請求（2026-10-11 使用者核准替代 IP 限流）。
- 角色保持 admin/clerk；網頁只建立 clerk，不提供自行升級為 admin 的功能。
- 五分鐘為 300000 ms；前端閒置鎖定不是可抗修改前端的伺服器五分鐘 session 到期機制。
- 管理金鑰不得進入前端；不得開放匿名查詢 Email 對照；既有 UUID、密碼與歷史快照保留。
- 登出不刪除 IndexedDB/localStorage 營運資料及備援，不悄悄取消已開始的儲存。
- 目前目錄不是 Git repository；不自動初始化、不假裝提交。每項以測試結果及 diff/檔案檢查作檢查點。
- 執行前讀 Supabase changelog 與當前 Auth 管理、session 撤銷及 Edge Function 部署文件；schema migration 用 CLI 建立名稱，核對既有雲端歷史再部署。

## Review Focus

1. 併發新增大小寫不同的同名帳號，最多產生一個可用身分，失敗不能遺留可登入孤兒（Task 1/2）。
2. 超時舊請求在登出／換人後才完成，不得重新顯示前一人的畫面或把其草稿帶給下一位（Task 4）。
3. 帳號已在雲端建立但本機儲存失敗，重試連結而非再建立身分（Task 3）。
4. 被停用者持有尚未過期 JWT，後端仍拒絕受保護操作；不能把 UUID 當 signOut 所需 token（Task 2）。
5. 系統時鐘倒退、儲存 API 不可用或頁籤休眠，不能意外延長／恢復已鎖定 session（Task 4）。

## Files and interfaces

- `supabase/functions/_shared/staff-auth.ts`：共用輸入正規化、有效使用者／店長檢查與一般錯誤回應；不從 metadata 授權。
- `supabase/functions/staff-login/index.ts`：匿名可呼叫的帳號密碼驗證端點，POST `{username,password}` → `{accessToken,refreshToken}`；失敗不回傳身分對照。
- `supabase/functions/staff-admin/index.ts`：取代目前 Email 邀請流程，POST actions `list/create/link-existing/reset-password/deactivate`，每次核對當下 admin/active。
- CLI 產生的 migration、`supabase/tests/username_auth.test.sql`：私有對照、限流／建立請求、最後店長保護、RLS/grants 與稽核。
- `supabase/functions/staff-auth.test.ts`：Deno 假 Auth/DB 依賴驗證 HTTP 流程；正式 Auth 另用專用測試身分整合驗證。
- `supabase-client.js`、`auth.test.js`：`AppAuth.signIn(username,password)`、`requireActiveUser()` → `{id,username,displayName,role}`、`signOut()` 只登出本瀏覽器；`manageStaff(body)` 呼叫受保護端點。
- `staff-ui.js`、`staff-ui.test.js`、`index.html`、`styles.css`：業務頁的店長專用雲端帳號區，與本機業務狀態明確分開。
- `inventory.js`、`inventory.test.js`、`app.js`、`navigation.test.js`：可選業務 authUserId、連結唯一性、新操作快照顯示姓名／帳號。
- `idle-session.js`、`idle-session.test.js`、`auth-ui.js`、`auth-ui.test.js`：計時、跨頁籤鎖定、登入生命周期及未儲存狀態清理。
- `docs/superpowers/runbooks/supabase-setup.md`：部署、身份配對、切換及回復；保留本機與雲端 migration 對照說明。

### Task 1: 私有帳號對照與安全約束

**Interfaces:** 私有 `staff_logins(user_id UUID PK, username TEXT UNIQUE, ready BOOLEAN)`；對照不可匿名讀取。`staff_account_requests(request_id UUID PK, actor_id UUID, username TEXT, user_id UUID NULL, status TEXT)` 追蹤建立重送，不保存密碼。私有持久化限流表及函式僅 service role 可用；鎖定同 key 的計數，避免併發繞過。profile 新增唯讀 username 投影供本人／店長讀取，寫入經後端受控流程；角色與啟用狀態仍以 profiles 為準。

- [ ] 寫 `supabase/tests/username_auth.test.sql`：`John` 與 `john` 正規化相同、2/33 字元及 @ 拒絕、匿名/clerk 無法讀對照或修改 username/role、只讀本人 profile、最後啟用 admin 停用／降級拒絕、未 ready 身分不被認為可登入；用 transaction/rollback。
- [ ] 在隔離測試資料庫執行 SQL，確認缺少結構時失敗；不得把正式庫存當 fixture。
- [ ] 用 `supabase migration new username_login` 建立 migration，實作上列結構、正規化唯一性、grants/RLS、profile 欄位級寫入限制、最後店長的交易鎖保護、稽核事件（不含秘密）。不開放匿名 SECURITY DEFINER 對照查詢。
- [x] 寫限流 SQL 測試：15 分鐘內第 11 次帳號失敗後拒絕再試、全站第 51 次請求拒絕；窗口到期可再試。先紅後綠完成原子計數及過期資料清理；真正多連線併發仍需整合驗收。
- [ ] 執行新 SQL 與既有 `supabase/tests/multiuser_inventory.test.sql`，全部成功並回復測試資料；確認 RLS/grants 與現有 role helpers 兼容。

### Task 2: 帳號登入與店長管理後端

**Interfaces:** `StaffSummary = {id,username,displayName,role,active}`。`list` → `{users:StaffSummary[]}`；`create` 輸入 `{requestId,username,displayName,password}` → `{user:StaffSummary}`；`link-existing` 輸入 `{userId,username}` 只可配對既有身分；`reset-password` 輸入 `{userId,password}`、`deactivate` 輸入 `{userId}` → `{ok:true}`。固定 clerk，不接受客戶端 role。新增使用伺服器產生的不公開 Auth Email 識別，且不依賴實際 Email 收信；既有身分繼續使用原識別與密碼。

- [ ] 寫 `supabase/functions/staff-auth.test.ts`：正確帳號原密碼成功、Email 輸入拒絕、密碼錯誤／不存在／停用回應一致；端點只接受 POST，OPTIONS 合法，回應 no-store，不洩露 Email 對照／管理金鑰／密碼。
- [ ] 執行 `deno test supabase/functions/staff-auth.test.ts` 確認缺實作時失敗。
- [x] 實作 `staff-login`：以隔離且不持久化的普通 Auth client 呼叫 `signInWithPassword`，驗證 ready/active；使用帳號＋全站持久化限流，絕不將原請求 JWT 傳入密碼 client，也不讀取任何來源 IP 標頭。
- [ ] 寫管理測試：匿名401、clerk/停用admin403；忽略／拒絕偽造 role；建立固定clerk、同 requestId 重試回同一身分、併發重名只有一個成功；Auth 或 profile 寫入失敗時無可登入孤兒；重設不回舊密碼、最後店長不能停用。
- [ ] 擴充 `staff-admin`，建立期間先保持不可登入，完成 Auth/profile/對照後才標 ready。部分失敗停用並補償，不盲目刪除已有身分；重試核對 actor/requestId/username，成功事件只記一次。既有帳號配對不修改密碼或 UUID。
- [ ] 移除目前 `admin.auth.admin.signOut(userId, 'global')` 的錯誤用法；按當前官方 API 實作受信任的 session 撤銷及 active/session 檢查。寫整合測試：持有舊 access/refresh token 的停用者、重設密碼後舊 session 均不可繼續受保護帳號操作；不以單純 mock 成功作為證明。
- [ ] Deno 測試全綠；在測試專案驗證建立、登入、限流、重設及停用，再清理專用測試身分。固定 SDK 版本並保留 Deno lockfile；公開登入函式免 gateway JWT，但管理函式仍驗證 JWT 與 live profile。

### Task 3: 前端帳號登入、店長帳號管理與業務連結

**Interfaces:** `AppAuth.signIn(username,password)` 保留 `{error}` 呼叫契約，內部呼叫 Task 2 登入端點並 `setSession`；不提供 Email fallback。`AppAuth.manageStaff(body)` 回 Task 2 action 結果。`Salesperson.authUserId` 可選，空字串代表未連結；建立／更新保留既有業務 ID/時間與報價快照，重複非空連結拒絕。

- [ ] 在 `auth.test.js`、`inventory.test.js` 與新 `staff-ui.test.js` 寫測試：帳號正規化、Email拒絕、登入 session錯誤不開 app；舊業務 JSON仍可讀；相同 authUserId 不能重複連結；店員不見管理區且直接操作拒絕；密碼不出現在 DOM列表、備份或 console。
- [ ] 執行 `node --test auth.test.js inventory.test.js staff-ui.test.js` 確認新案例先失敗。
- [ ] 修改 `supabase-client.js` 的登入與目前身份介面；`index.html` 改帳號 text input/autocomplete=username，Auth password 用 current-password、管理新增／重設用 new-password；在 `auth-ui.js` 保留統一登入失敗文案。
- [ ] 建立 `staff-ui.js`：只在 admin 時讀取雲端帳號清單，新增初始密碼、重設與停用皆有 loading/error 狀態及成功後清除密碼；不讓 clerk選admin，不顯示Email、不提供查看舊密碼。CSS沿用原元件，不擴大視覺重設。
- [ ] 修改本機業務正規化與 UI，店長明確選擇 authUserId；既有業務不依姓名猜測。不混淆本機業務停用與雲端停用登入；雲端失敗不顯示本機成功。
- [ ] 加入 `cloud account created but local link save fails` 測試：雲端只建立一次，顯示已建立但未連結，允許用返回的 userId 重試本機儲存；成功後唯一連結成立。
- [ ] 修改進貨建立／收貨／付款快照來源為 `displayName || username || id`；本人 fallback 同規則，舊快照不重寫。更新 navigation fixture 及 script cache版本，跑全套 `node --test`。

### Task 4: 五分鐘閒置鎖定及登出清理

**Interfaces:** `window.IdleSession.start({userId,onExpire})` → `{stop()}`，期限固定300000ms；同來源 localStorage 只保存 `{userId,lastActivity,locked}`，不保存 token/營運資料。`AppAuthUI.start(onAuthenticated,onSignedOut)` 新增登出清理 callback，`onSignedOut` 關閉可操作狀態並清空記憶體草稿。使用登入 generation 防過期非同步回呼重開 app。

- [ ] 寫 `idle-session.test.js` 假時鐘測試：299999ms 未逾期、300000ms只觸發一次、互動重新計時、背景／休眠到期後第一個事件不能續命、重新整理不延長、其他裝置獨立、同來源頁籤活動同步及鎖定同步。
- [ ] 寫時鐘倒退與 localStorage 讀寫拋錯測試：保守鎖定、顯示需重新登入，不以不可靠時間／儲存恢復舊session；登出狀態不註冊重複 listener/timer。
- [ ] 執行 `node --test idle-session.test.js` 確認紅燈後，實作 `idle-session.js` 的絕對期限、事件檢查、跨頁籤 storage 通知與 localStorage鎖定；focus/visibilitychange只檢查不算操作。
- [ ] 寫 `auth-ui.test.js`：逾時立即隱藏 app，signOut網路失敗仍鎖定且刷新不恢復；重新登入清除鎖定並啟動計時；手動登出同樣清理；舊 requireActiveUser/bootstrap 延遲完成不重開已登出畫面。
- [ ] 修改 `auth-ui.js` 使用 Task 3登入接口，逾時先鎖定後 `signOut`；`app.js` 清除 currentUser、購物車、報價/進貨明細、編輯表單與敏感詳情；等待已啟動儲存完成並避免其 callback 重啟可操作狀態。鎖定期間拒絕新營運提交。
- [ ] 補 `in-flight save finishes after logout` 與換人登入測試：已成功儲存保留，未送出草稿不帶到下一人、資料庫與備援未刪除。執行 `node --test` 全綠。

### Task 5: 安全部署、既有店長切換與驗收

**Files:** `docs/superpowers/runbooks/supabase-setup.md`、Edge Function部署設定（若CLI產生 config 才更新）、前述 tests/文件。

- [x] 寫 runbook：備份與 migration 歷史核對、部署 schema/functions、關閉公開自行註冊、確認登入端點帳號＋全站限流、正式店長指定 username、配對既有 UUID、原密碼登入驗證、最後才更新網頁入口。不可在文件或對話要求店長透露密碼。
- [x] 正式部署前確認連線工具與專案，讀取 schema／function 狀態及 advisors；若沒有部署權限或無法證明 session撤銷，停止正式切換，交付已驗證成果並列出明確阻礙。2026-10-11 IP 需求由使用者明示核准的全站限流取代。
- [ ] 使用專用測試身分執行 SQL、Deno與瀏覽器驗收；真實頁面只能在產品允許的瀏覽器控制範圍測試，不繞過先前 file URL安全限制。不能測的部分明確標為未驗證。
- [ ] 執行 `node --test`；`deno test supabase/functions/staff-auth.test.ts`；測試資料庫跑兩份 SQL。記錄結果、migration/部署版本與安全 advisor輸出，不把計畫中的命令稱為已通過。
- [ ] 店長本人確認新帳號可用後才能切換；由店長實際輸入密碼，不代猜帳號、不重設原密碼。若切換失敗回復舊網頁入口，保留新帳號對照、已完成停用／重設及全部營運資料。
- [ ] 按所選執行模式做最終獨立檢查與必要修正；完成報告區分本機測試、雲端部署與人工驗收，提醒本機 IndexedDB權限隔離／跨裝置同步仍未完成。

## 自我檢查與執行交接

已對照規格涵蓋帳號唯一性、保留原身份與密碼、店長管理、業務連結、後端授權／撤銷、限流、五分鐘閒置、登出清理、遷移及復原。Review Focus五項均分配到對應測試。部署工具、既有身份名稱與店長實際驗證必須在執行時取得，未以假設填成完成。

此計畫待使用者審閱後執行。依先前偏好採 Native：主代理逐項實作，最後由獨立 reviewer檢查；不在審閱前修改正式登入。
