import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const inventoryContext = { crypto: webcrypto, window: {} };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), inventoryContext);
const I = inventoryContext.window.Inventory;
const item = { name: '前煞車皮', category: '零件', sku: 'BRK-001', barcode: '4710000000012', cost: 180, price: 350, stock: 50, minimumStock: 1, notes: '' };
const oil = { ...item, name: '機油', sku: 'OIL-001', barcode: '4710000000029', price: 120 };

// 依指定時間建立銷售；每筆一張銷售單，方便驗證筆數與金額。
function stateWithSales(entries) {
  let state = I.addSalesperson(I.addItem(I.addItem(I.emptyState(), item), oil), { name: '阿明' });
  for (const entry of entries) state = I.recordSale(state, { barcode: entry.barcode ?? item.barcode, quantity: entry.quantity ?? 1, salespersonId: state.salespeople[0].id });
  return { ...state, sales: state.sales.map((sale, index) => ({ ...sale, createdAt: entries[index].at, saleNumber: `S-${index}` })) };
}

test('dashboard summary uses Taipei month boundaries and compares with the previous month', () => {
  const state = stateWithSales([
    { at: '2026-08-31T16:00:00Z', quantity: 2 },
    { at: '2026-09-30T15:59:59Z', quantity: 1 },
    { at: '2026-09-30T16:00:00Z', quantity: 3 },
    { at: '2026-10-31T15:59:59Z', barcode: oil.barcode, quantity: 1 },
    { at: '2026-10-31T16:00:00Z', quantity: 5 },
  ]);
  const summary = I.dashboardSummary(state, '2026-10');
  assert.equal(summary.previousMonth, '2026-09');
  assert.deepEqual({ ...summary.current }, { total: 350 * 3 + 120, quantity: 4, count: 2 });
  assert.deepEqual({ ...summary.previous }, { total: 350 * 3, quantity: 3, count: 2 });
  assert.equal(Math.round(summary.change.total * 100) / 100, Math.round(120 / 1050 * 10000) / 100);
  assert.equal(summary.change.count, 0);
});

test('dashboard summary returns null change when the previous month has no sales', () => {
  const summary = I.dashboardSummary(stateWithSales([{ at: '2026-10-05T02:00:00Z' }]), '2026-10');
  assert.equal(summary.change.total, null);
  assert.equal(summary.change.count, null);
});

test('dashboard trend lists six months across a year boundary ending at the selected month', () => {
  const summary = I.dashboardSummary(stateWithSales([{ at: '2025-11-10T02:00:00Z' }, { at: '2026-02-10T02:00:00Z', quantity: 2 }]), '2026-02');
  assert.deepEqual(Array.from(summary.trend, point => point.month), ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(Array.from(summary.trend, point => point.total), [0, 0, 350, 0, 0, 700]);
});

test('dashboard top items rank by amount then quantity and keep only the limit', () => {
  const state = stateWithSales([
    { at: '2026-10-01T02:00:00Z', barcode: oil.barcode, quantity: 4 },
    { at: '2026-10-02T02:00:00Z', quantity: 1 },
    { at: '2026-10-03T02:00:00Z', barcode: oil.barcode, quantity: 1 },
  ]);
  const summary = I.dashboardSummary(state, '2026-10');
  assert.deepEqual(Array.from(summary.topItems, entry => [entry.name, entry.quantity, entry.total]), [['機油', 5, 600], ['前煞車皮', 1, 350]]);
  assert.equal(I.dashboardSummary(state, '2026-10', { topLimit: 1 }).topItems.length, 1);
  assert.throws(() => I.dashboardSummary(state, '2026-13'), /月份/);
});

function node(id = '') {
  return { id, value: '', textContent: '', hidden: false, dataset: {}, style: {}, children: [], attributes: {},
    classList: { values: new Set(), add(name) { this.values.add(name); } },
    setAttribute(key, value) { this.attributes[key] = value; },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); } };
}
async function overviewUi() {
  const elements = new Map();
  const $ = (id) => { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); };
  const context = { ...I, state: stateWithSales([{ at: '2026-10-05T02:00:00Z', quantity: 2 }]), $, formatNumber: value => String(value), setStatus() {}, document: { createElement: () => node() }, renderMonthlySales: { detailMonth: '' } };
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  vm.runInNewContext(app.slice(app.indexOf('function dashboardChangeText('), app.indexOf('renderMonthlySales.renderOverview = renderMonthlyOverview;')), context);
  return { context, $ };
}
const cellsOf = row => row.children.map(cell => cell.textContent);

test('manager overview adds month-over-month change, six trend bars and top items', async () => {
  const { context, $ } = await overviewUi();
  context.renderMonthlyOverview('2026-10', true);
  assert.equal($('monthly-sales-total-change').textContent, '上月無資料');
  assert.equal($('monthly-sales-total-change').hidden, false);
  assert.equal($('monthly-trend').children.length, 6);
  assert.equal($('monthly-trend').children[5].children[1].children[0].attributes.style, 'height: 100%');
  assert.equal($('monthly-trend').children[0].children[1].children[0].attributes.style, 'height: 0%');
  assert.deepEqual(cellsOf($('monthly-top-items').children[0]), ['1', '前煞車皮', '2', '700']);
  assert.equal($('monthly-top-panel').hidden, false);
});

test('staff overview hides and clears manager-only blocks', async () => {
  const { context, $ } = await overviewUi();
  context.renderMonthlyOverview('2026-10', true);
  context.renderMonthlyOverview('2026-10', false);
  assert.equal($('monthly-trend-panel').hidden, true);
  assert.equal($('monthly-top-panel').hidden, true);
  assert.equal($('monthly-sales-total-change').hidden, true);
  assert.equal($('monthly-trend').children.length, 0);
  assert.equal($('monthly-top-items').children.length, 0);
});

test('monthly sales tab becomes the merged overview and keeps mobile access', async () => {
  const [html, app] = await Promise.all([readFile(new URL('./index.html', import.meta.url), 'utf8'), readFile(new URL('./app.js', import.meta.url), 'utf8')]);
  assert.match(html, /data-page-target="monthly-sales" data-mobile-page>營運總覽<\/button>/);
  assert.doesNotMatch(html, /data-page-target="dashboard"/);
  assert.match(html, /data-page="monthly-sales" aria-label="營運總覽"/);
  for (const id of ['monthly-trend-panel', 'monthly-top-panel']) assert.match(html, new RegExp(`id="${id}"[^>]*data-role="admin" hidden`));
  assert.match(app, /renderMonthlySales\.renderOverview\?\.\(month, isAdmin\)/);
});

test('dashboard summary ranks motorcycles by units and lists every month with sales newest first', () => {
  const state = stateWithSales([
    { at: '2026-09-03T02:00:00Z', quantity: 1 },
    { at: '2026-10-01T02:00:00Z', barcode: oil.barcode, quantity: 3 },
    { at: '2026-10-02T02:00:00Z', quantity: 2 },
  ]);
  // 把兩個品項分別標成不同車型的機車，驗證只依分類挑出並依台數排序。
  const motorState = { ...state, items: state.items.map(entry => ({ ...entry, category: entry.name === '機油' ? '機車' : '零件' })) };
  const summary = I.dashboardSummary(motorState, '2026-10');
  assert.deepEqual(Array.from(summary.motorcycles, entry => [entry.name, entry.quantity]), [['機油', 3]]);
  assert.deepEqual(Array.from(summary.months, entry => [entry.month, entry.total, entry.count]), [['2026-10', 1060, 2], ['2026-09', 350, 1]]);
});

test('manager sees the month list until choosing a month, then that month detail with a back button', async () => {
  const { context, $ } = await overviewUi();
  context.renderMonthlyOverview('2026-10', true);
  assert.equal($('monthly-months-panel').hidden, false);
  assert.equal($('monthly-detail-panel').hidden, true);
  assert.deepEqual(cellsOf($('monthly-months-list').children[0]).slice(0, 4), ['2026-10', '700', '1', '2']);
  assert.equal($('monthly-months-list').children[0].children[4].children[0].dataset.month, '2026-10');
  context.renderMonthlySales.detailMonth = '2026-10';
  context.renderMonthlyOverview('2026-10', true);
  assert.equal($('monthly-months-panel').hidden, true);
  assert.equal($('monthly-detail-panel').hidden, false);
  assert.equal($('monthly-detail-back').hidden, false);
  assert.equal($('monthly-detail-title').textContent, '2026-10 銷售明細');
  context.renderMonthlyOverview('2026-09', true);
  assert.equal($('monthly-detail-panel').hidden, true, 'changing the month returns to the list');
});

test('staff keep the direct monthly detail without the month list or motorcycle chart', async () => {
  const { context, $ } = await overviewUi();
  context.renderMonthlyOverview('2026-10', false);
  assert.equal($('monthly-detail-panel').hidden, false);
  assert.equal($('monthly-months-panel').hidden, true);
  assert.equal($('monthly-motorcycle-panel').hidden, true);
  assert.equal($('monthly-detail-back').hidden, true);
});

test('manager motorcycle chart draws bars relative to the top seller', async () => {
  const { context, $ } = await overviewUi();
  context.state = { ...context.state, items: context.state.items.map(entry => ({ ...entry, category: '機車' })) };
  context.renderMonthlyOverview('2026-10', true);
  const row = $('monthly-motorcycle-chart').children[0];
  assert.equal(row.children[0].textContent, '1. 前煞車皮');
  assert.equal(row.children[1].children[0].attributes.style, 'width: 100%');
  assert.equal(row.children[2].textContent, '2 台｜700');
});
