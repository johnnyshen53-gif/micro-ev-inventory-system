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

// 電池電壓、容量可以有一位小數（例：58.8V 25Ah、48V 18.2Ah）。
test('battery voltage and capacity accept one decimal place', async () => {
  const state = I.addItem(I.emptyState(), { name: '電池', category: '電池', voltage: '48', capacity: '18.2', price: 16400, cost: 0, stock: 0, minimumStock: 0 });
  assert.equal(state.items[0].name, '電池 48V 18.2Ah');
  assert.match(state.items[0].sku, /^88\d{4}4818\d{3}$/, '料號取整數部分，仍是 13 碼');
  const renamed = I.updateItem(state, state.items[0].id, { ...state.items[0], voltage: 58.8, capacity: 25 }).items[0];
  assert.equal(renamed.name, '電池 58.8V 25Ah', '換規格時舊的小數規格會被換掉');
  assert.throws(() => I.addItem(I.emptyState(), { name: '電池', category: '電池', voltage: 48.25, capacity: 20, price: 1, cost: 0, stock: 0, minimumStock: 0 }), /最多一位小數/);
  assert.throws(() => I.addItem(I.emptyState(), { name: '電池', category: '電池', voltage: 100, capacity: 20, price: 1, cost: 0, stock: 0, minimumStock: 0 }), /1～99\.9/);
  const importContext = { window: {}, document: { getElementById: () => null } };
  vm.runInNewContext(await read('item-import.js'), importContext);
  const rows = importContext.window.ItemImport.buildPreview(I.emptyState(), '品項名稱,分類,車種,售價,電壓,容量\n電池,電池,,22000,58.8,25\n電池,電池,,1,48.25,20\n', { inventory: I }).rows;
  assert.deepEqual([...rows.map(row => row.errors.join())], ['', '電壓最多一位小數']);
  assert.equal(rows[0].name, '電池 58.8V 25Ah');
});
