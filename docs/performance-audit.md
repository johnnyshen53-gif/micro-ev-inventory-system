# 頁面載入效能診斷（2026-10-17）

> 本報告記錄當時正式版 `05f65b5` 的診斷結果與改善候選；後續程式變更不會追溯改寫原始量測，不能把「尚未實施」解讀為目前版本的即時狀態。

## 範圍與證據等級

- 受測正式版：GitHub Pages `main`，commit `05f65b5`；Supabase 專案 `kruflsixtejmhaucjikc`，狀態 `ACTIVE_HEALTHY`，PostgreSQL `17.11`，Region `ap-south-1`。這是**唯讀診斷**，未修改程式、資料庫或正式設定。
- 使用者回報的「台灣登入後需 3–5 秒」是問題基準。使用者自行在正式站輸入憑證並按登入後，本次取得登入態重新整理的壁鐘時間、Chrome DevTools Network 登入時序及有效的手動 Performance CPU 錄製。Network 時序以**第一個登入請求**為 0 秒，不等同按鈕點擊的精確時戳；CPU 錄製含使用者等待時間，須只看登入附近的選取區間。
- 證據分三類：`已確認／程式碼`、`已量測／登入態刷新、Chrome Network、手動 CPU 錄製、未登入網路與唯讀 SQL`、`待細分驗證`。以下預估值僅為規劃假設，不是改善承諾。
- 實際專案是原生 HTML、CSS、JavaScript，沒有 React、打包器或前端路由套件。因此 React 重複渲染、`useEffect` 依賴與 React 訂閱清理**不適用**；應檢查 `render()`、`hashchange` 和頁面事件。

## A. 已確認的瓶頸與量測證據

### 載入流程與 API 地圖

| 入口／頁面 | 程式路徑 | Supabase 請求與等待關係 |
| --- | --- | --- |
| 未登入首次開啟 | `index.html` → 12 個依序宣告的傳統 `<script>` → `auth-ui.js` | 初始呼叫 `requireActiveUser()` 嘗試恢復登入；無 session 才顯示登入畫面。HTML 同步載入外部 Supabase SDK 和 QR 函式庫，所有功能的 JS 都在登入頁載入。 |
| 帳密登入 | `auth-ui.js` → `supabase-client.js` → `staff-login` Edge Function | `staff-login` 內部依序執行登入限流保留、帳號查詢、Auth 密碼驗證、profile 查詢、限流完成；前端收到 token 後 `setSession()`。這些步驟不可直接省略，屬於安全驗證。 |
| 登入後顯示主畫面 | `auth-ui.js:accept()` → `requireActiveUser()` → `app.js:bootstrap()` → `cloud-data.js:loadSnapshot()` | 前端先做 `profiles` 精確查詢與 `current_staff_session_valid` RPC；`loadSnapshot()` **再次**呼叫同一驗證，然後才 `Promise.all` 下載 16 張表（店長 16、店員 12）。完成轉換、IndexedDB 寫入及所有頁面的 `render()` 後才可能顯示主畫面。這是已確認的關鍵路徑與重複驗證，不是 N+1 資料列查詢。 |
| 店長額外等待 | `app.js:bootstrap()` → `StaffUI.start()` → `refresh()` | 正式版 `main` 會等待帳號管理清單；`manageStaff()` 又驗證 profile／session，才呼叫 `staff-admin` Edge Function。若清單慢，**即使主資料已備妥，畫面仍被擋住**。另一隔離工作區有尚未提交／部署的改善，不屬於本次正式版。 |
| 庫存清單、報價單、客戶、供應商、進貨等 `#` 頁 | `app.js:showPage()` | 一般切頁只切換已在記憶體的 DOM，沒有重新下載 16 張表；但登入時的 `render()` 會先渲染所有頁面，不僅當前頁。 |
| `#repairs` 維修單 | `showPage()` → `RepairUI.load()` → `loadRepairOrders()` | 額外一次 `requireActiveUser()`（profile + session RPC）後，並行讀取 `repair_orders`、`repair_lines`；每次切回維修頁都可能重做。 |
| 店長 `#monthly-sales` | `showPage()` → `renderMonthlySales(true)` | `get_monthly_salesperson_performance`、`get_monthly_sale_assignments` 兩條分支並行；**各自**先做 profile + session RPC，所以每次更新最多可見 4 次重複驗證加 2 次業務 RPC。一般店員不觸發店長績效 RPC。 |

表清單請見 `cloud-data.js:49–69`；它們使用明確欄位清單、沒有 `select('*')`。`sales`／`sale_lines`、`quotations`／`quotation_lines`、`purchases`／`purchase_lines` 在前端合併；目前**沒有每筆資料額外發一個 API 的網路 N+1**。`repair-ui.js` 以 `lines.filter()` 組合每張維修單，資料長大時可能形成前端 O(單數×明細數) CPU 成本，但目前不是已證實的 3–5 秒來源。

### 可重現的已量測數字

量測日期 2026-10-17；由本機網路發出，**不是台灣手機 4G／5G**。`curl` 各 5 次，未登入且未帶 API key；TTFB 包含建立連線與伺服器回應，不等於資料庫執行時間。

| 目標 | 首次 total / TTFB | 後 4 次 total 範圍 | 代表意義 |
| --- | ---: | ---: | --- |
| Pages `index.html`（41,202 B，HTTP 200） | 362 / 328 ms | 152–156 ms | 靜態頁傳送本身不足以單獨解釋 3–5 秒。 |
| Supabase Auth gateway `/auth/v1/health`（HTTP 401） | 410 / 410 ms | 67–78 ms | **僅測未授權 gateway**；401 是沒有 key 的預期結果，不能當成功登入 API 耗時。 |
| `staff-login` 的 OPTIONS（HTTP 204） | 278 / 278 ms | 217–256 ms | 只測 CORS／Edge 前置回應，**不是密碼驗證**。 |
| jsDelivr Supabase SDK（218,544 B） | 399 / 256 ms | 359–443 ms | 第三方同步腳本是初始頁的重量來源之一；這是無瀏覽器快取的 `curl` 下載值。 |

獨立 in-app 瀏覽器刷新到可存取的**登入畫面**，3 次壁鐘時間為 402、507、412 ms。這包含自動化與 accessibility 觀察開銷，不能充當 DOMContentLoaded／LCP 或登入完成時間。該工具沒有直接提供 Network waterfall／Performance entries；後續改在使用者已開啟的 Chrome DevTools 觀察正式登入態 Network，但沒有匯出含敏感資料的 HAR。

使用者自行登入後，在同一正式站、同一 in-app 瀏覽器及目前的手機寬度視窗，連續 5 次重新整理並等到「月銷售清單」出現：**4,352、4,237、3,565、3,505、3,951 ms**（中位數 3,951 ms；範圍 3.5–4.4 秒）。另一次預試為 4,272 ms，未納入 5 次統計。這是從自動化發起重新整理到 accessibility 標題可見的端到端壁鐘時間，含工具輪詢開銷；並非按下登入按鈕到完成，也不是瀏覽器 LCP。刷新頁面時觀察到資料與管理員月績效正常呈現，但未記錄客戶／銷售內容。此結果**重現了慢刷新現象**。

同日 Chrome DevTools Network 在**已登入店長、暖快取、未停用快取、無網路限速**下清空紀錄後單次刷新：共 **52 個請求**，`DOMContentLoaded` **167 ms**、`Load` **170 ms**、Network 全部請求 `Finish` **4.75 秒**。`Finish` 不是主畫面可操作時間，也包含無關資源；這些數字與上述 in-app 瀏覽器的壁鐘時間屬於不同量測，不能直接相減。這次已看到腳本從磁碟快取取得，故靜態下載並非此輪的主要等待。篩選該**單次**刷新：`profiles` **7 次**（各 202–960 ms）、`current_staff_session_valid` **7 次**（各 146–238 ms）；`staff-admin` 一次預檢 **291 ms**、一次實際請求 **1.62 秒**。Network 確認重複驗證與較慢管理員請求；但這些請求不全串行，不能相加成總耗時，也尚未量到 DB 與 CPU 的個別占比。未保存含 Authorization 或客戶資料的 HAR。

另一次**從登入畫面、由使用者親自按登入**的 Chrome Network 錄製（39 個請求；與上一段暖刷新不同輪）：以 `staff-login` 開始排隊為 **t=0**，其 CORS 預檢約 **540 ms**，實際登入服務從 t≈0.54 到 **2.62 秒**，其中伺服器回應等待約 **2.08 秒**；第一支 `profiles` 於 t≈**2.79 秒**排隊。`staff-admin` 於 t≈**6.31 秒**排隊，預檢／排隊約 **248 ms**，實際服務端等待約 **1.54 秒**，到 t≈**8.10 秒**完成。t≈2.62–6.31 秒的 **約 3.69 秒**包含 `setSession()`、profile／session 檢查、16 表下載、IndexedDB 與渲染，**未能再精確拆開**，也不能把它全算為資料庫耗時。此登入輪的 `profiles` 與 `current_staff_session_valid` 也各有 **7 次**（分別約 180 ms–1.02 秒與 196–587 ms），部分並行；沒有讀取或保存密碼、token、回應內容。

同次登入以 Chrome Performance 的**手動 Record／Stop**取得有效 CPU 時間軸（錄製全長 42.77 秒，含等待使用者操作，不能當作登入時間）；選取含登入互動與其後請求的 **17.91–26.43 秒**區間，DevTools Summary 顯示主執行緒 `Scripting` **22 ms**、`Rendering` **8 ms**、`Painting` **10 ms**、`System` **32 ms**，互動 INP **33 ms**。此輪前端 CPU 沒有占滿約 8.5 秒的選取區間，支持等待主要發生在非 CPU 工作，但選取區間較實際登入鏈寬，且尚未逐個長任務／IndexedDB callback 歸因；不能宣稱前端完全沒有優化空間。未匯出 trace，以免含敏感資訊。

同一測試環境再次以 `curl` 各 10 次量測：Pages HTML total 為 148–369 ms，`app.js` 為 169–219 ms；未授權 Auth gateway（HTTP 401）為 62–112 ms。每次 `curl` 都是新的連線，不能視為瀏覽器快取命中，也不能拿 gateway 401 代表登入／資料 API。Pages HTML 的 DNS 約 2.8–4.3 ms、TCP 完成約 37–41 ms、TLS 完成約 77–134 ms；其餘時間包含 HTTP 等待與傳輸。這些靜態／未授權請求遠短於 3.5–4.4 秒刷新壁鐘時間，支持優先量測登入後資料與渲染鏈，但**不能單憑差值精確分配耗時**。

正式 `index.html` 與 `app.js` 回應 `Cache-Control: max-age=600`；原始大小分別 41,202 B、104,106 B。`inventory.js` 67,745 B，QR 腳本 56,694 B，Supabase SDK 218,544 B；本機主要 HTML/CSS/JS 檔合計約 284 KB（未計外部函式庫）。腳本使用 `?v=` 版本參數，但 CDN 路徑 `@supabase/supabase-js@2` 是浮動主版本；正式回應提供 600 秒快取。本次 Chrome 暖刷新觀察到多個腳本命中磁碟快取，冷快取仍待另測。

### 資料庫與索引：有警示，但目前不能定為主因

- Performance Advisor 當下顯示 **42** 項 `unindexed_foreign_keys`（INFO）、8 項 `auth_rls_initplan`（WARN）、17 項 `unused_index`（INFO）、3 項 `multiple_permissive_policies`（WARN）。42 項是潛在成長／特定 join 風險，**不是 42 個已量到的慢查詢**。[Supabase 對缺少外鍵索引的說明](https://supabase.com/docs/guides/observability/advisors?queryGroups=lint&lint=0001_unindexed_foreign_keys)。
- `pg_stat_user_tables` 估計：`items` 2、`inventory_transactions` 10、`customers` 2、`sales` 3、`quotations` 1、`quotation_lines` 1、`inventory_serials` 4；這些數字為統計估計，不是精確 `count(*)`。故現階段傳輸往返與初始資料取得模式比小表掃描更值得優先驗證。
- 只讀 `EXPLAIN`（**沒有 `ANALYZE`、沒有資料寫入**）：未篩選的 `inventory_transactions` 是 `Seq Scan`，估計成本 `0.00..1.05`；以 `quotation_id` 篩選 `quotation_lines` 也是 `Seq Scan`，估計成本 `0.00..15.25`。後者缺 `quotation_id` 索引，但目前前端載入整張表，新增索引不會讓該全表請求直接變快。SQL editor 角色與實際登入者 RLS 不同，這些 plan **不能**代表正式使用者的完整執行時間。
- `profiles(id)` 已有主鍵索引；`sale_lines(sale_id)`、`repair_lines(repair_order_id)` 也已索引，勿重複建立。Advisor 的 8 項 RLS initplan 涉及 `member_profiles`、`member_orders`、`inventory_items`、`inventory_movements`、`inventory_images` 等另一組表；本次主要載入的店內 16 張表不在該 8 項清單。RLS 仍需保持。[Supabase RLS 效能指南](https://supabase.com/docs/guides/database/postgres/row-level-security-performance)。

## B. 尚待驗證的假設

1. **登入鏈的剩餘細分**：已取得從第一個登入請求至 `staff-admin` 回應約 8.10 秒的時序，以及有效 CPU 錄製；但 Edge Function 內部五步、`setSession()`、16 表中最慢的一支、IndexedDB 寫入與 `render()` 各占幾毫秒仍未知。需在受控測試環境加計時標記，或以更完整的 Network/Performance 選取與瀏覽器事件對齊；不能由 3.69 秒中段差值自行推定各成分。
2. **Region 往返**：資料庫在 `ap-south-1`，台灣用戶到該 Region 的實際 RTT 尚未量。Supabase 建議選接近使用者的 Region；若更換 Region，需要建立新專案並遷移資料，不能當作這次診斷的直接設定變更。[區域選擇](https://supabase.com/docs/guides/platform/regions)、[更換區域](https://supabase.com/docs/guides/troubleshooting/change-project-region-eWJo5Z)。
3. **Free 方案／冷啟動**：首次與連續操作可能不同，但未取得函式與 Auth 的實際追蹤，不能把差異直接歸因於 Free 方案。
4. **前端渲染／IndexedDB**：`render()` 同步更新所有頁面的 DOM，之後還有 `setAppEnabled()` 等操作；本次有效 Performance 錄製的登入附近區間僅見約 22 ms 腳本及 18 ms 渲染／繪製，但沒有把各 callback 與長任務逐一歸因。資料增長、第三方擴充功能或低階手機 CPU 的影響仍待驗證。
5. **正式公司隔離範圍**：此 repo 的主要店內表以 active staff/admin RLS 為基礎，並未在本次證明存在 `company_id` 多租戶鍵。任何快取、單一聚合 RPC 或分頁方案都必須先確認實際租戶模型，不得把不同公司資料合併或只靠前端篩選。

## C. 依證據排序的改善方案（均尚未實施）

| 優先 | 建議 | 為何先做／預期改善 | 驗證與風險 |
| --- | --- | --- | --- |
| P0 | **重複量測登入並細分 3.69 秒中段**；以店長與店員各測首次／暖快取／重新整理，對齊 click、首個請求與畫面可操作時間。 | 單次登入 Network 已量到 Edge 登入預檢 540 ms、服務 2.08 秒、後續中段約 3.69 秒、管理員末段約 1.79 秒；手動 Performance 錄製顯示選取區間的 CPU 活動遠少於牆鐘時間。單次樣本尚不足以推 p75／p95。 | HAR／trace 可能含 JWT、密碼請求、電話與客戶資料；只保存於受控位置，分享前去識別；不要在正式環境加入輸出敏感資料的診斷記錄。 |
| P1 | 店長帳號清單改成主畫面顯示後再載入；保留載入與錯誤狀態。 | 程式碼確定此支目前阻擋畫面；單次刷新 Network 量到實際 Edge 請求 1.62 秒、預檢 291 ms。可將此分支從關鍵路徑移走，但需再量它與其他工作的重疊，不能直接宣稱節省兩者相加。 | 不可讓未授權者看見帳號清單；登出後的舊回應須被丟棄。另一隔離分支已有未部署原型，**本報告未套用**。 |
| P1 | 去除同一次登入／刷新中的重複 `requireActiveUser()`，在已驗證的同一 bootstrap 生命週期傳遞使用者；寫入操作仍逐次驗證。 | 單次 Chrome 暖刷新實測 `profiles` 與 session RPC **各 7 次**；可減少不必要的多輪 API，但需先界定哪些檢查必須保留、哪些分支並行，不能將 14 次耗時直接相加。 | 閒置登出、帳號停用及 session 撤銷不得沿用舊權限；需自動化測試。 |
| P2 | 首屏只載當前頁必需資料，次要頁面延後載入；常用讀取做受控分頁，避免整表下載。 | 目前 16 表並行取回，總時間由最慢請求決定，且所有頁先渲染。資料量增長後收益大；**不能**單純刪掉庫存／序號必需資料。 | 報價、庫存與銷售的原子 RPC 和狀態一致性不變；每次切頁需明確 loading/error，快取按帳號／公司隔離並在寫入後失效。 |
| P2 | 檢查外部腳本與 DOM；QR 函式庫只在列印 QR 時載入、固定 SDK 小版本與可重現建置，並記錄腳本 parse／main-thread long tasks。 | 目前登入頁也下載 QR 與所有模組。優先用 Network／Performance 判定下載或 parse 是否足夠慢，再決定拆分；避免憑原始 KB 猜測。 | 保持 CSP／供應鏈安全、離線與列印功能可用，版本變更需回歸測試。 |
| P3 | 依實際慢查詢與成長量逐個補索引、檢查相關 RLS；不要一次建立 42 個索引。 | 小表 `Seq Scan` 合理；索引也有寫入與儲存成本。當分頁／篩選改為資料庫端後，再對應查詢建索引。 | 先在隔離資料庫 `EXPLAIN`/負載驗證；保持 RLS 與跨公司隔離，不改寫庫存交易語意。 |
| P3 | 若台灣真實 RTT 對多輪 API 影響明顯，再做 Region 遷移成本／風險評估。 | Region 變更需新專案、資料與 Auth／Edge Functions 遷移；不能只改 URL。 | 須先盤點停機、備份、驗證、回退及費用，不直接動正式專案。 |

預估方式：使用者回報的 **3–5 秒**已由登入態重新整理的 5 次壁鐘觀察部分重現；另一次帳密登入的 Network 請求鏈從首個請求至管理員清單完成約 **8.10 秒**，兩者是**不同操作、不同輪次**，不能互相取代。P1 的可合理預期是移除「店長清單分支」及重複驗證的關鍵路徑時間，**不是**承諾某個固定秒數。待多次相同操作得出各段 p50／p75／p95 後，以 `新預估 ≈ 原總時間 − 可移走的串行段` 建立數值範圍；首輪驗收目標可設定登入到可操作主畫面的 p75 至少下降 **30%**，同時功能與安全檢查維持原狀。未完成可操作時間與串行／並行對齊前，不應宣稱可從 3–5 秒降到特定秒數。

## D. 建議修改的程式檔案（本次沒有修改）

- `staff-ui.js`、`staff-ui.test.js`：店長清單非阻擋載入、錯誤與登出競態測試。
- `auth-ui.js`、`supabase-client.js`、`cloud-data.js`、對應 `auth.test.js`／`cloud-data.test.js`：同一次登入避免重複驗證，保留權限撤銷檢查。
- `app.js`、`repair-ui.js`、`navigation.test.js`：按頁載入與渲染、維修頁重入、月銷售重複驗證的測試。
- `index.html`：若 Network 證明腳本下載／解析是瓶頸，再做資源載入順序、QR 延後載入及版本釘選。
- `supabase/migrations/`：**僅在後續獲准且證據支持時**建立索引／RLS migration；本次不產生或執行 migration。

## E. 可能需要的 SQL 索引（候選，未執行）

| 候選 | 前提與用途 | 本次判斷 |
| --- | --- | --- |
| `quotation_lines(quotation_id)` | 若報價明細改為依報價單查詢／分頁。 | Advisor 指出缺失；目前整表讀取且只有約 1 筆，**先改查詢形狀，再量測索引**。 |
| `quotations(customer_id)` | 若有客戶報價歷史篩選。 | Advisor 指出缺失；目前無相應首頁篩選，非立即效能修正。 |
| `inventory_serials(sale_line_id)` | 若從銷售明細依 FK 找實物序號。 | Advisor 指出缺失；確認新查詢使用後再評估。 |
| `inventory_transactions(created_at DESC)`（可能含租戶鍵） | 若首頁只取最近異動，改為 server-side `ORDER BY ... LIMIT`。 | 現有 `(item_id, created_at DESC)` 不能直接等同全店最近異動索引；先確認實際查詢、RLS 和租戶鍵。 |

已存在 `profiles(id)`、`sale_lines(sale_id)`、`repair_lines(repair_order_id)`；不要重建。所有候選先依實際 `WHERE`／`ORDER BY`、租戶欄位、`EXPLAIN` 與寫入負擔評估，**不可用新增索引代替 RLS**。

## F. 可重複測試與驗收標準

### 1. 靜態與網路階段（不需登入，不寫資料）

在**台灣實際使用的網路與裝置**執行 5–10 次，另記錄日期、ISP、裝置、瀏覽器、冷／暖快取。以下命令只讀，`time_connect` 為 TCP 完成、`time_appconnect` 為 TLS 完成；差值可分開計算 DNS、TCP、TLS、TTFB（TTFB = `time_starttransfer - time_pretransfer` 更接近請求送出後等待）。

```sh
for i in 1 2 3 4 5; do
  curl -sS -o /dev/null --max-time 15 \
    -w 'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} pretransfer=%{time_pretransfer} first_byte=%{time_starttransfer} total=%{time_total} bytes=%{size_download} http=%{http_code}\n' \
    'https://johnnyshen53-gif.github.io/micro-ev-inventory-system/'
done
```

不要拿未授權 `/auth/v1/health` 的 401 或 `staff-login` OPTIONS 的 204 當成登入成功時間。`curl` 自身不保留瀏覽器 HTTP 快取，冷／暖快取必須看瀏覽器 Network。

### 2. 瀏覽器 Network／Performance（部分登入態證據已取得）

在正式站點開 DevTools，Network 勾選 Preserve log；先用全新瀏覽器設定檔或停用快取記錄首次開啟，再以正常快取記錄重新整理。以**同一個帳號、同一網路**各跑至少 5 次：未登入開頁、按登入到主畫面可操作、`#list`↔`#quotations`、`#repairs`、店長 `#monthly-sales`。逐次記錄每支 API 的 URL 路徑（**刪掉 token/query 敏感值**）、請求數、開始與結束時間、重疊與串行關係、TTFB、大小；Performance 錄製登入到可操作畫面的主執行緒長任務與 rendering。不得把 HAR 原樣上傳到 GitHub 或貼在報告中，因為可能包含 Authorization、Cookie、客戶資料。

目前已有登入態刷新壁鐘數據、Chrome Network 單次暖刷新與帳密登入時序、Chrome Performance 手動錄製及唯讀 SQL 計畫；**沒有匯出 HAR／trace**。先前「Record and reload」令分頁意外轉為 `about:blank`，已恢復網站，該次無效 trace 不作證據；後續改用手動 Record、由使用者按登入、再 Stop，取得有效 CPU 時間軸。本次為手機寬度，只顯示月銷售，故未量其他主要頁面的切換；仍需同一裝置多次重測、桌面模式切頁，以及將 click／網路／畫面可操作事件精確對齊。

### 3. 資料庫唯讀 EXPLAIN 與前後比較

只對 `SELECT` 使用 `EXPLAIN`，**不用 `EXPLAIN ANALYZE`**，不執行寫入函式、migration 或 `SET` 權限繞過。對照登入態 Network 找出最慢的 PostgREST 查詢，再在相同角色／RLS 條件的隔離環境比對 plan；SQL editor 的管理角色 plan 僅作候選方向。每項優化至少記錄前後 p50、p75、p95、API 數量、最大串行鏈、資料量與錯誤率。

驗收：主畫面可操作時間的 p75 相對同環境基準下降 ≥30% 作為**第一輪目標**；店長／店員、首次／刷新／切頁皆無權限或資料漏失；庫存進出、序號、報價與維修完工的交易一致性測試全過；RLS 不停用、無跨公司資料可見；網路失敗時仍有既有唯讀快取與錯誤提示。若沒有達標，回到 trace 重新排序瓶頸，不以「索引警示減少」代替使用者體感驗收。

### 4. 本機與正式模式的比較邊界

正式模式從 GitHub Pages 載入靜態檔，本機 `file://` 或本機 HTTP 伺服器沒有 Pages CDN 網路段；兩者仍可能呼叫同一個遠端 Supabase。`file://`、`localhost`、Pages 是不同瀏覽器 origin，本機 IndexedDB／登入狀態／快取不共享，不能把本機有快取的結果與正式冷開直接比較。應用同一份版本、同帳號、同裝置，分開記錄「靜態載入」與「遠端 API／渲染」兩段。
