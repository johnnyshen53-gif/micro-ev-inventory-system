import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const context = { crypto: webcrypto, window: {} };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const { suggestedPrice, addItem, emptyState, validateState } = context.window.Inventory;

// 售價加成：成本 ×（1＋加成%），無條件進位到 10 元，不能有浮點誤差。
test('suggested price adds the markup and rounds up to the next 10 dollars', () => {
  assert.equal(suggestedPrice(873, 35), 1180);      // 1178.55 → 1180
  assert.equal(suggestedPrice(100, 10), 110);       // 剛好 110，不可因浮點誤差變 120
  assert.equal(suggestedPrice(100, 35), 140);       // 135 → 140
  assert.equal(suggestedPrice(1000, 15.5), 1160);   // 1155 → 1160
  assert.equal(suggestedPrice('250.5', 0), 260);    // 加成 0 也照樣進位
  assert.equal(suggestedPrice(0, 50), 0);
  assert.equal(suggestedPrice('', 35), null);
  assert.equal(suggestedPrice(100, null), null);
  assert.equal(suggestedPrice(-1, 10), null);
});

test('items keep the fixed-price flag', () => {
  const base = { name: '控制器', category: '電控元件', sku: 'C1', barcode: 'C1', cost: 100, price: 999, stock: 0, minimumStock: 0 };
  const locked = addItem(emptyState(), { ...base, priceLocked: true });
  assert.equal(locked.items[0].priceLocked, true);
  assert.equal(validateState(locked).items[0].priceLocked, true);
  assert.equal(addItem(emptyState(), base).items[0].priceLocked, false);
});

test('cloud data reads and writes the fixed-price flag and exposes markup RPCs', async () => {
  const source = await readFile(new URL('./cloud-data.js', import.meta.url), 'utf8');
  assert.match(source, /fields: 'id,name,category,sku,barcode,price,stock,minimum_stock,warranty_months,notes,supplier_id,price_locked,vehicle_model_id'/);
  assert.match(source, /priceLocked: row\.price_locked === true/);
  assert.match(source, /price_locked: item\.priceLocked === true/);
  assert.match(source, /bonusRpc\('get_price_markups', \{\}\)/);
  assert.match(source, /bonusRpc\('save_price_markups', \{ p_markups: markups \}\)/);
});

test('bonus page has one markup input per item category and the item form has a fixed-price checkbox', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const categories = [...html.matchAll(/<input id="markup-\d" data-category="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(categories, ['車身', '電池', '電控元件', '機構元件', '外觀元件']);
  assert.match(html, /<input id="item-price-locked" type="checkbox">/);
  assert.match(html, /id="item-price-hint"/);
});
