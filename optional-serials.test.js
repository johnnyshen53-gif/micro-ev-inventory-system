import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 序號全面改選填＋保固系統停用（預設規則）。舊的「保固＋嚴格序號」規則仍保留在 inventory.js 的 config，可再開回來。
const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const I = context.window.Inventory;
const plain = value => JSON.parse(JSON.stringify(value));

const ready = () => {
  let state = I.addItem(I.emptyState(), { name: '小偉士', category: '車身', price: 30000, cost: 0, stock: 3, minimumStock: 0, warrantyMonths: 12, serialNumbers: ['VIN-001'] });
  state = I.addSalesperson(state, { name: '業務' });
  return state;
};

test('defaults: warranties are off and serials are optional', () => {
  assert.deepEqual(plain(I.config), { warranties: false, strictSerials: false });
});

test('a vehicle body can be added with fewer serials than stock, and sold without a serial or a customer', () => {
  const state = ready();
  const body = state.items[0];
  assert.equal(state.serials.length, 1, '新增品項：序號可以少於庫存');
  assert.throws(() => I.addItem(I.emptyState(), { name: '車', category: '車身', price: 1, cost: 0, stock: 1, minimumStock: 0, warrantyMonths: 0, serialNumbers: ['A', 'B'] }), /初始序號數超過庫存/);
  // 不選序號、不選客戶：可以賣，不建立保固，序號還在庫。
  const sold = I.recordSaleBatch(state, { salespersonId: state.salespeople[0].id, lines: [{ itemId: body.id, quantity: 2 }] });
  assert.equal(sold.items[0].stock, 1);
  assert.equal(sold.warranties.length, 0);
  assert.equal(sold.serials.filter(s => s.status === 'in_stock').length, 1);
  // 在庫序號（1）可能比庫存（1→0）多，資料仍然有效，還能再選序號賣出。
  const last = I.recordSaleBatch(sold, { salespersonId: state.salespeople[0].id, lines: [{ itemId: body.id, quantity: 1, serialIds: [sold.serials[0].id] }] });
  assert.equal(last.items[0].stock, 0);
  assert.equal(last.serials[0].status, 'sold');
  assert.equal(last.serials[0].customerId, '', '沒有客戶也可以');
  assert.doesNotThrow(() => I.validateState(last));
  assert.throws(() => I.recordSaleBatch(state, { salespersonId: state.salespeople[0].id, lines: [{ itemId: body.id, quantity: 1, serialIds: ['x', 'y'] }] }), /序號/);
});

test('manual stock-out of a serialized item does not require serials, but cannot pick more than the quantity', () => {
  const state = ready();
  const body = state.items[0];
  const out = I.recordTransaction(state, { itemId: body.id, type: 'out', quantity: 1, note: '展示車', createdBy: 'u1' });
  assert.equal(out.items[0].stock, 2);
  assert.throws(() => I.recordTransaction(state, { itemId: body.id, type: 'in', quantity: 1, serialNumbers: ['N1', 'N2'], createdBy: 'u1' }), /新增序號數超過入庫數量/);
  assert.equal(I.recordTransaction(state, { itemId: body.id, type: 'in', quantity: 2, createdBy: 'u1' }).items[0].stock, 5, '入庫可以不填序號');
});

test('the warranty page is hidden, warranty replacement is not offered, and repairs allow optional battery serials', async () => {
  const [html, app, repair] = await Promise.all(['index.html', 'app.js', 'repair-ui.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.match(html, /data-page-target="warranties" hidden>保固管理/);
  assert.match(html, /<option value="warranty_out" hidden disabled>/);
  assert.match(app, /const WARRANTY_ENABLED = false;/);
  assert.match(app, /if \(!WARRANTY_ENABLED && page === 'warranties'\) page = 'sales';/);
  assert.match(repair, /if \(ids\.length > line\.quantity\)/);
  assert.doesNotMatch(repair, /電池保固已更新/);
});
