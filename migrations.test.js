import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

// Supabase 透過 API 執行的 DELETE／UPDATE 必須有 WHERE（pg_safeupdate），本機測試資料庫沒有這個機制，
// 所以用這個測試檢查：每個函式的「最新版本」裡，DELETE／UPDATE 陳述句都要有 WHERE 條件。
test('latest function definitions never run DELETE or UPDATE without a WHERE clause', async () => {
  const dir = new URL('./supabase/migrations/', import.meta.url);
  const files = (await readdir(dir)).filter(name => name.endsWith('.sql')).sort();
  const latest = new Map();
  for (const name of files) {
    const sql = await readFile(new URL(name, dir), 'utf8');
    for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_.]+)\s*\([\s\S]*?\$\$([\s\S]*?)\$\$/gi)) {
      latest.set(match[1].toLowerCase(), { file: name, body: match[2] });
    }
  }
  const problems = [];
  for (const [fn, { file, body }] of latest) {
    for (const statement of body.matchAll(/\b(delete\s+from|update\s+[a-z_.]+\s+set)\b[^;]*;/gi)) {
      if (!/\bwhere\b/i.test(statement[0])) problems.push(`${fn}（${file}）：${statement[0].replace(/\s+/g, ' ').slice(0, 80)}`);
    }
  }
  assert.deepEqual(problems, []);
});
