import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 品項停用：不能入庫、進貨、銷售、報價；出庫與盤點仍可（和 supabase/tests/item_active.test.sql 相同）。
const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const I = context.window.Inventory;

const ready = () => {
  let state = I.addSupplier(I.emptyState(), { name: '供應商' });
  state = I.addItem(state, { name: '舊款後照鏡', category: '外觀元件', price: 800, cost: 0, stock: 5, minimumStock: 1, warrantyMonths: 0, supplierId: state.suppliers[0].id });
  state = I.addSalesperson(state, { name: '業務' });
  state = I.addCustomer(state, { name: '王', phone: '0911' });
  const item = state.items[0];
  return { state, item, inactive: I.updateItem(state, item.id, { ...item, active: false }) };
};

test('items are active by default and can be switched off', () => {
  const { state, inactive } = ready();
  assert.equal(state.items[0].active, true);
  assert.equal(inactive.items[0].active, false);
  assert.equal(I.updateItem(inactive, inactive.items[0].id, { ...inactive.items[0], active: true }).items[0].active, true);
});

test('an inactive item cannot be stocked in, purchased, sold or quoted, but can still be stocked out or counted', () => {
  const { inactive: state, item } = ready();
  assert.throws(() => I.recordTransaction(state, { itemId: item.id, type: 'in', quantity: 1, createdBy: 'u' }), /已停用，無法入庫/);
  assert.throws(() => I.updateItem(state, item.id, { ...state.items[0], stock: 9 }), /已停用，無法入庫/);
  assert.throws(() => I.createPurchase(state, { supplierId: state.suppliers[0].id, lines: [{ itemId: item.id, quantity: 1, unitCost: 100 }] }), /已停用，不能進貨/);
  assert.throws(() => I.recordSaleBatch(state, { salespersonId: state.salespeople[0].id, lines: [{ itemId: item.id, quantity: 1 }] }), /已停用，無法銷售/);
  assert.throws(() => I.createQuotation(state, { customerId: state.customers[0].id, salespersonId: state.salespeople[0].id, lines: [{ itemId: item.id, quantity: 1 }] }), /已停用，無法報價/);
  assert.equal(I.recordTransaction(state, { itemId: item.id, type: 'out', quantity: 2, note: '報廢', createdBy: 'u' }).items[0].stock, 3);
  assert.equal(I.recordTransaction(state, { itemId: item.id, type: 'adjust', quantity: 0, note: '盤點', createdBy: 'u' }).items[0].stock, 0);
  assert.equal(I.vehicleItemChoices(state, '', '外觀元件').length, 0, '報價選單不列停用品項');
});

test('screens: admin-only switch, labels and pickers skip inactive items', async () => {
  const [html, app, cloud] = await Promise.all(['index.html', 'app.js', 'cloud-data.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.match(html, /<label class="check-item" data-role="admin"><input id="item-inactive" type="checkbox"> 停用此品項/);
  assert.match(app, /active: !\$\('item-inactive'\)\?\.checked/);
  assert.match(app, /（已停用，不能入庫）/);
  assert.match(app, /entry\.supplierId === supplierSelect\.value && entry\.active !== false/);
  assert.match(app, /item\.category === category && item\.active !== false && \(!needsModel/);
  assert.match(app, /item\.active !== false && item\.minimumStock > 0 && item\.stock <= item\.minimumStock/);
  assert.match(cloud, /active: item\.active !== false \}\);/);
});
