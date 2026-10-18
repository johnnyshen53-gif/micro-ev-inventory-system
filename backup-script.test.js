import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 備份程式的安全底線：只匯出資料、密碼不落地、備份不放進專案資料夾、營業資料與帳號分開存。
test('database backup script keeps passwords out of files and backups out of the repo', async () => {
  const script = await readFile(new URL('./scripts/backup-db.sh', import.meta.url), 'utf8');

  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /set -euo pipefail/);
  // 連線字串存檔前會移除密碼；密碼只用 read -s 讀進這次執行的環境變數。
  assert.match(script, /sed -E 's#\^\(postgres\(ql\)\?:\/\/\[\^:\/@\]\+\):\[\^@\]\*@#\\1@#'/);
  assert.match(script, /read -r -s PGPASSWORD/);
  assert.doesNotMatch(script, /PGPASSWORD[^\n]*>/);
  // 預設存到「文件」底下，不在專案資料夾內，避免被 git 提交。
  assert.match(script, /BACKUP_ROOT="\$\{BACKUP_DIR:-\$HOME\/Documents\//);
  // 營業資料與登入帳號分開兩個檔，還原時只換營業資料。
  assert.match(script, /--data-only[^\n]*\\\n\s+--table='public\.\*' --table='app_private\.\*' \\\n\s+--file="\$OUT\/data\.sql"/);
  assert.match(script, /--table='auth\.users' --table='auth\.identities' \\\n\s+--file="\$OUT\/auth\.sql"/);
  assert.match(script, /"data\.sql public\.items" "data\.sql public\.sales" "auth\.sql auth\.users"/);
});

test('backup docs explain that the web JSON export cannot restore the cloud database', async () => {
  const [doc, readme] = await Promise.all([
    readFile(new URL('./docs/database-backup.md', import.meta.url), 'utf8'),
    readFile(new URL('./README.md', import.meta.url), 'utf8'),
  ]);
  assert.match(doc, /bash scripts\/backup-db\.sh/);
  assert.match(doc, /SET session_replication_role = replica/);
  assert.match(doc, /--single-transaction/);
  assert.match(readme, /docs\/database-backup\.md/);
  assert.doesNotMatch(readme, /首次資料移轉/);
});
