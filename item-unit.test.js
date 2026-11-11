// 品項單位（個、組、支…）：選填，最多 10 個字；顯示在庫存清單的庫存後面，CSV 匯入、匯出都有這一欄。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = file => readFile(new URL(`./${file}`, import.meta.url), 'utf8');
const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await read('inventory.js'), context);
const I = context.window.Inventory;
const base = { name: '座墊', category: '外觀元件', price: 950, cost: 0, stock: 5, minimumStock: 0 };

test('items keep an optional unit of up to 10 characters', () => {
  assert.equal(I.addItem(I.emptyState(), { ...base, unit: ' 組 ' }).items[0].unit, '組');
  assert.equal(I.addItem(I.emptyState(), base).items[0].unit, '');
  assert.throws(() => I.addItem(I.emptyState(), { ...base, unit: '一二三四五六七八九十一' }), /單位最多 10 個字/);
  const state = I.addItem(I.emptyState(), { ...base, unit: '個' });
  assert.equal(I.updateItem(state, state.items[0].id, { ...state.items[0], unit: '支' }).items[0].unit, '支');
});

test('CSV import reads the unit column', async () => {
  const importContext = { window: {}, document: { getElementById: () => null } };
  vm.runInNewContext(await read('item-import.js'), importContext);
  const X = importContext.window.ItemImport;
  assert.match(X.templateCsv(), /目前庫存,單位,最低庫存/);
  const preview = X.buildPreview(I.emptyState(), '品項名稱,分類,車種,售價,單位\n座墊,外觀元件,,950,個\n', { inventory: I });
  assert.equal(preview.nextState.items[0].unit, '個');
});

test('the unit is stored, loaded, edited in the form and shown after the stock', async () => {
  const [cloud, html, app] = await Promise.all(['cloud-data.js', 'index.html', 'app.js'].map(read));
  assert.match(cloud, /unit: row\.unit \?\? ''/);
  assert.match(cloud, /unit: item\.unit \?\? '',/);
  assert.match(html, /<input id="item-unit" list="item-unit-options" maxlength="10"/);
  assert.match(app, /unit: \$\('item-unit'\)\?\.value \?\? ''/);
  assert.match(app, /if \(index === 6 && item\.unit\) value = `\$\{value\} \$\{item\.unit\}`;/);
});
