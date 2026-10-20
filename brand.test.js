import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

// 品牌：電小二 Volt Buddy。確認網頁標題、標誌檔與替代文字都在，舊名稱不再出現。
test('index uses the 電小二 Volt Buddy brand with existing logo files', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<title>電小二微型電動車庫存系統｜Volt Buddy<\/title>/);
  assert.doesNotMatch(html, /微型機車店庫存|MOTORCYCLE SHOP/);
  for (const file of ['assets/logo.svg', 'assets/logo-dark.svg', 'assets/icon.svg']) {
    assert.match(html, new RegExp(`(src|href)="${file.replace('.', '\\.')}"`));
    await access(new URL(`./${file}`, import.meta.url));
  }
  assert.match(html, /class="hero-logo" src="assets\/logo-dark\.svg" alt="電小二 Volt Buddy"/);
  assert.match(html, /class="auth-logo" src="assets\/logo\.svg" alt="電小二 Volt Buddy"/);
});
