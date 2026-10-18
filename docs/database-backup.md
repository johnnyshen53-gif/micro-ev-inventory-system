# 雲端資料庫備份與還原

Supabase 免費方案**沒有自動備份**，資料被誤刪或改錯時沒有後台可以一鍵還原。所以店長要自己定期執行備份程式，把雲端資料存一份到自己的電腦。

網頁上的「匯出備份」（JSON 檔）只能拿來查看、核對資料，**沒辦法還原回雲端**。真正能用來還原的是本文的資料庫備份。

## 一次性準備

1. 安裝 PostgreSQL 匯出工具（不需要 Docker）：
   ```
   brew install libpq
   ```
   如果出現 `command not found: brew`，請先依 <https://brew.sh> 的說明安裝 Homebrew。
2. 準備資料庫密碼。這是 Supabase 後台資料庫設定頁（Project Settings → Database）裡的密碼，**不是**網站的登入密碼。忘記的話可以在同一頁按「Reset database password」重設；重設不影響網站登入。

## 每次備份

在專案資料夾的終端機執行：

```
bash scripts/backup-db.sh
```

- **第一次**會請你貼上連線字串：Supabase 後台 → 專案頁上方「Connect」→「Session pooler」，複製 `postgresql://` 開頭那串貼上即可，裡面的 `[YOUR-PASSWORD]` 不用改，程式會自動拿掉。之後就不會再問。
- **每次**都會詢問資料庫密碼。密碼不會被存起來。
- 備份會存在「文件／機車店資料庫備份／日期時間」資料夾，裡面有三個檔：

| 檔案 | 內容 | 什麼時候用 |
|---|---|---|
| `data.sql` | 庫存、銷售、客戶、報價、保固、維修、分紅等營業資料 | 資料被誤刪或改錯時 |
| `auth.sql` | 店長與店員的登入帳號 | 整個 Supabase 專案重建時才需要 |
| `schema.sql` | 當時的資料表結構 | 對照用；正式結構以 `supabase/migrations` 為準 |

建議頻率：**每週一次**，加上月底結帳、分紅計算前各一次。舊備份可以自己刪；至少留最近 4 份。

**安全提醒**：備份含客戶個資與帳號資料。只存在自己的電腦或加密的外接硬碟，不要上傳到 GitHub、不要傳給別人。

## 還原（出事時）

還原會把雲端的營業資料**整個換成備份當下的內容**，備份之後新增的資料會消失。所以請照順序做，不確定的話先問人，不要自己硬做：

1. **先通知所有人停止操作網站。**
2. **先再備份一次目前的狀態**（`bash scripts/backup-db.sh`）。萬一還原錯了，還能退回來。
3. 選好要還原的那一份備份資料夾，在終端機執行（把 `<備份資料夾>` 換成實際路徑；可以把資料夾直接拖進終端機視窗）：
   ```
   PSQL=/opt/homebrew/opt/libpq/bin/psql   # Intel Mac 改成 /usr/local/opt/libpq/bin/psql
   URL="$(head -n 1 ~/.config/micro-ev-backup/db-url)"
   TABLES="$($PSQL "$URL" -At -c "select string_agg(format('%I.%I', schemaname, tablename), ', ') from pg_tables where schemaname in ('public','app_private')")"
   $PSQL "$URL" --single-transaction -v ON_ERROR_STOP=1 \
     -c "SET session_replication_role = replica" \
     -c "TRUNCATE $TABLES" \
     -f "<備份資料夾>/data.sql"
   ```
   - `--single-transaction`：全部成功才生效，中途出錯就整個取消，不會留下一半的資料。
   - `session_replication_role = replica`：還原時暫停觸發器，避免庫存、分紅被重複計算。
   - `TRUNCATE`：先清空營業資料表，再放回備份內容。**不會**動到登入帳號。
4. 重新整理網站，抽查庫存、最近的銷售與客戶資料是否正確，再通知大家恢復使用。

登入帳號（`auth.sql`）只有在 Supabase 專案整個重建、所有人都登不進去時才需要還原，步驟較特殊，請找技術協助處理。
