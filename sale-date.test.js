import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 銷售日期：結帳可補登「今天或以前」的日期；營運總覽依銷售日期歸月，保固從銷售日期起算。
const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const Inventory = context.window.Inventory;
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const shiftDays = days => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const helmet = 'b0000000-0000-4000-8000-000000000001';
const base = () => Inventory.validateState({ ...Inventory.emptyState(),
  items: [{ id: helmet, name: '安全帽', category: '外觀元件', sku: '55001', barcode: '55001', price: 500, cost: 0, stock: 5, minimumStock: 0, warrantyMonths: 6 }],
  customers: [{ id: 'c1', memberNumber: 'M000001', name: '客戶', phone: '0900000000', address: '', note: '', active: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  salespeople: [{ id: 's1', name: '業務', active: true, isSales: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] });
const sell = (state, saleDate) => Inventory.recordSaleBatch(state, { salespersonId: 's1', customerId: 'c1', saleDate, lines: [{ itemId: helmet, quantity: 1 }] });

test('checkout keeps the chosen past date, defaults to today and rejects future or invalid dates', () => {
  const back = shiftDays(-40);
  const next = sell(base(), back);
  assert.equal(next.sales[0].saleDate, back);
  assert.equal(next.warranties[0].purchasedAt, back, '保固從銷售日期起算');
  assert.equal(sell(base(), '').sales[0].saleDate, today);
  assert.equal(sell(base(), undefined).sales[0].saleDate, today);
  assert.throws(() => sell(base(), shiftDays(1)), /不可晚於今天/);
  assert.throws(() => sell(base(), '2026-02-30'), /格式無效/);
  assert.throws(() => sell(base(), '1999-12-31'), /無效/);
});

test('monthly sales and the dashboard group by sale date; old sales fall back to the Taipei creation date', () => {
  const state = { ...base(), sales: [
    { id: 'a', saleNumber: 'S-A', itemId: helmet, itemName: '安全帽', barcode: '55001', quantity: 1, unitPrice: 500, subtotal: 500, createdAt: '2026-11-02T03:00:00.000Z', saleDate: '2026-10-31', serialIds: [], serialNumbers: [] },
    // 舊單：UTC 10/31 17:00 ＝ 台灣 11/1 01:00，歸 11 月。
    { id: 'b', saleNumber: 'S-B', itemId: helmet, itemName: '安全帽', barcode: '55001', quantity: 2, unitPrice: 500, subtotal: 1000, createdAt: '2026-10-31T17:00:00.000Z', serialIds: [], serialNumbers: [] },
  ] };
  assert.deepEqual(Inventory.salesForMonth(state, '2026-10').map(sale => sale.id), ['a']);
  assert.deepEqual(Inventory.salesForMonth(state, '2026-11').map(sale => sale.id), ['b']);
  assert.equal(Inventory.dashboardSummary(state, '2026-10').current.total, 500);
  assert.equal(Inventory.dashboardSummary(state, '2026-11').current.total, 1000);
  assert.equal(Inventory.saleDateOf(state.sales[1]), '2026-11-01');
  assert.throws(() => Inventory.validateState({ ...state, sales: [{ ...state.sales[0], saleDate: '10/31' }] }), /銷售日期格式無效/);
});

test('the checkout form has a date field and the cloud call sends it', async () => {
  const [html, app, cloud] = await Promise.all(['index.html', 'app.js', 'cloud-data.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.match(html, /<input id="sale-date" type="date" required/);
  assert.match(app, /saleDate: \$\('sale-date'\)\?\.value/);
  assert.match(app, /input\.max = today;/);
  assert.match(cloud, /p_sale_date: addedSales\[0\]\.saleDate/);
  assert.match(cloud, /created_at,sale_date'/);
  assert.match(cloud, /saleDate: sale\.sale_date \?\? ''/);
});
