// 低庫存只看「有設定最低庫存（大於 0）」的品項：沒設定最低庫存的零件，庫存 0 也不提醒；停用的品項不列入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const exporter = await readFile(new URL('./inventory-export.js', import.meta.url), 'utf8');
const rule = /item\.active !== false && item\.minimumStock > 0 && item\.stock <= item\.minimumStock/g;

test('every low-stock check in the app uses the same rule', () => {
  // 首頁統計、低庫存提示、分類按鈕上的數字、清單的「低庫存」標籤，共四處。
  assert.equal(app.match(rule).length, 4);
  assert.doesNotMatch(app.replace(rule, ''), /item\.stock <= item\.minimumStock/, '不能還有舊規則');
  assert.match(exporter, /item\.active !== false && item\.minimumStock > 0 && item\.stock <= item\.minimumStock \? '是' : ''/);
});

test('the export marks low stock only for items with a minimum', () => {
  const context = { window: {} };
  vm.runInNewContext(exporter, context);
  const row = item => context.window.InventoryExport.inventoryCsv({ items: [{ id: 'x', name: 'x', category: '外觀元件', sku: '1', barcode: '1', price: 1, stock: 0, active: true, notes: '', ...item }] }).split('\r\n')[1].split(',');
  const low = item => row(item)[11]; // 店員版：品名、分類、車種、料號、條碼、售價、特價、會員價、庫存、單位、最低庫存、低庫存
  assert.equal(low({ minimumStock: 0 }), '', '沒設定最低庫存：不算低庫存');
  assert.equal(low({ minimumStock: 2, stock: 2 }), '是');
  assert.equal(low({ minimumStock: 2, stock: 3 }), '');
  assert.equal(low({ minimumStock: 2, stock: 0, active: false }), '', '停用不算');
});

test('the inventory list merges SKU and barcode into one column', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<th>車種<\/th><th>料號／條碼<\/th><th>售價<\/th><th>庫存<\/th><th>最低<\/th><th>供應商<\/th><th>操作<\/th>/);
  assert.match(app, /item\.sku \|\| item\.barcode \|\| '—'/);
  assert.match(app, /code\.textContent = `條碼 \$\{item\.barcode\}`/);
});
