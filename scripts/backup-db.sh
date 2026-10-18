#!/usr/bin/env bash
# 雲端資料庫備份：把 Supabase 上的營業資料與登入帳號匯出到這台電腦。
#
# 用法（在專案資料夾的終端機執行）：
#   bash scripts/backup-db.sh
#
# 第一次執行會請你貼上 Supabase 的連線字串（不含密碼），之後只會詢問資料庫密碼。
# 密碼不會被存起來；備份檔預設存在「文件／機車店資料庫備份」，不在專案資料夾內，
# 所以不會被 git 提交。可用環境變數 BACKUP_DIR 改存放位置。
set -euo pipefail

CONFIG_DIR="${MICRO_EV_BACKUP_CONFIG:-$HOME/.config/micro-ev-backup}"
URL_FILE="$CONFIG_DIR/db-url"
BACKUP_ROOT="${BACKUP_DIR:-$HOME/Documents/機車店資料庫備份}"

# 1. 找 pg_dump。Homebrew 的 libpq 預設不放進 PATH，所以也到它的固定位置找。
find_pg_dump() {
  local dir
  for dir in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
    if [ -x "$dir/pg_dump" ]; then echo "$dir/pg_dump"; return 0; fi
  done
  command -v pg_dump || return 1
}
if ! PG_DUMP="$(find_pg_dump)"; then
  echo "找不到 pg_dump（PostgreSQL 的匯出工具）。請先在終端機執行：" >&2
  echo "  brew install libpq" >&2
  echo "如果連 brew 都沒有，請先依 https://brew.sh 的說明安裝 Homebrew。" >&2
  exit 1
fi

# 2. 讀取連線字串；第一次執行時請使用者貼上並存檔（只有自己能讀）。
if [ ! -s "$URL_FILE" ]; then
  echo "第一次使用：請到 Supabase 後台 → 專案頁上方「Connect」→ 選「Session pooler」，"
  echo "複製那串 postgresql:// 開頭的連線字串後貼上（裡面的 [YOUR-PASSWORD] 不用改）。"
  printf '連線字串：'
  IFS= read -r url
  # 拿掉密碼部分：不論是 [YOUR-PASSWORD] 佔位字或真的密碼都移除，檔案裡只留帳號與主機。
  url="$(printf '%s' "$url" | sed -E 's#^(postgres(ql)?://[^:/@]+):[^@]*@#\1@#')"
  case "$url" in
    postgres://*|postgresql://*) ;;
    *) echo "這看起來不是 postgresql:// 開頭的連線字串，已取消。" >&2; exit 1 ;;
  esac
  ( umask 077; mkdir -p "$CONFIG_DIR"; printf '%s\n' "$url" > "$URL_FILE" )
  echo "已記住連線字串（不含密碼）：$URL_FILE"
fi
DB_URL="$(head -n 1 "$URL_FILE")"

# 3. 詢問密碼（輸入時畫面不會顯示），只放在這次執行的記憶體裡。
if [ -z "${PGPASSWORD:-}" ]; then
  printf '資料庫密碼（輸入時不會顯示）：'
  IFS= read -r -s PGPASSWORD
  echo
  export PGPASSWORD
fi

# 4. 建立這次的備份資料夾（以時間命名，只有自己能讀）。
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_ROOT/$STAMP"
( umask 077; mkdir -p "$OUT" )

LOG="$OUT/pg_dump.log"
fail() {
  echo "" >&2
  echo "備份失敗：$1" >&2
  if [ -s "$LOG" ]; then echo "--- 詳細訊息 ---" >&2; cat "$LOG" >&2; fi
  echo "常見原因：密碼錯誤、網路不通，或 pg_dump 版本比雲端資料庫舊（請執行 brew upgrade libpq）。" >&2
  rm -rf "$OUT"
  exit 1
}

echo "開始備份到：$OUT"
# 營業資料：public（庫存、銷售、客戶…）與 app_private（分紅等內部資料）。
"$PG_DUMP" --dbname="$DB_URL" --data-only --no-owner --no-privileges \
  --table='public.*' --table='app_private.*' \
  --file="$OUT/data.sql" 2>>"$LOG" || fail "匯出營業資料時發生錯誤。"
# 登入帳號另存一檔：平常還原只需要營業資料；整個專案重建時才需要還原帳號。
"$PG_DUMP" --dbname="$DB_URL" --data-only --no-owner --no-privileges \
  --table='auth.users' --table='auth.identities' \
  --file="$OUT/auth.sql" 2>>"$LOG" || fail "匯出登入帳號時發生錯誤。"
# 結構：資料表長相的對照用（正式結構以 supabase/migrations 為準）。
"$PG_DUMP" --dbname="$DB_URL" --schema-only --no-owner --no-privileges \
  --schema=public --schema=app_private \
  --file="$OUT/schema.sql" 2>>"$LOG" || fail "匯出結構時發生錯誤。"

# 5. 檢查備份內容：商品、銷售與登入帳號的資料段落都要在。
for check in "data.sql public.items" "data.sql public.sales" "auth.sql auth.users"; do
  set -- $check
  grep -q "^COPY $2 " "$OUT/$1" || fail "備份檔 $1 裡找不到 $2，請不要使用這份備份。"
done
TABLES="$(grep -c '^COPY ' "$OUT/data.sql")"
SIZE="$(du -h "$OUT/data.sql" | cut -f1)"
# pg_dump 會提醒「circular foreign-key」：這是正常的，還原時會用 replica 模式處理，所以成功時不顯示。
rm -f "$LOG"
chmod 600 "$OUT"/*.sql

echo "備份完成：營業資料 $TABLES 張資料表（$SIZE），登入帳號另存在 auth.sql。"
echo "位置：$OUT"
echo "提醒：備份檔含客戶與登入帳號資料，請勿上傳到 GitHub 或分享給他人。"
