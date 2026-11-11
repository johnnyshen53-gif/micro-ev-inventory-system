import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 庫存清單匯出（CSV）。
const context = { window: {} };
vm.runInNewContext(await readFile(new URL('./inventory-export.js', import.meta.url), 'utf8'), context);
const X = context.window.InventoryExport;

const state = { items: [
  { id: 'p', name: '後照鏡, 左', category: '外觀元件', vehicleModelId: 'v1', sku: '44001', barcode: '44001', price: 800, unit: '支', specialPrice: 700, memberPrice: null, staffPrice: 0, priceChangedAt: '2026-11-10T17:05:00.123456+00:00', cost: 300, stock: 1, minimumStock: 2, active: true, supplierId: 's1', warrantyMonths: 0, voltage: null, capacity: null, notes: '說"明"' },
  { id: 'b', name: '鋰電池 48V 20Ah', category: '電池', vehicleModelId: 'v1', sku: '88001', barcode: '88001', price: 5000, cost: 3000, stock: 3, minimumStock: 1, active: false, supplierId: '', warrantyMonths: 6, voltage: 48, capacity: 20, notes: '=SUM(A1)' },
] };
const names = { vehicleName: id => (id === 'v1' ? '小偉士' : '未設定'), supplierName: id => (id === 's1' ? '車廠' : '未指定') };

test('manager export has cost and stock value, sorted by category; rows are Excel-safe', () => {
  const csv = X.inventoryCsv(state, { includeCost: true, ...names });
  assert.ok(csv.startsWith('﻿'), 'BOM 讓 Excel 正確顯示中文');
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], '品名,分類,車種,料號,條碼,售價,特價,會員價,員工價,成本,庫存金額,庫存,單位,最低庫存,低庫存,狀態,供應商,保固月數,電壓（V）,容量（Ah）,最後價格異動時間,備註');
  assert.equal(lines[1], "鋰電池 48V 20Ah,電池,小偉士,88001,88001,5000,,,,3000,9000,3,,1,,停用,未指定,6,48,20,,'=SUM(A1)");
  assert.equal(lines[2], '"後照鏡, 左",外觀元件,小偉士,44001,44001,800,700,,0,300,300,1,支,2,是,啟用,車廠,0,,,2026-11-11 01:05,"說""明"""');
});

test('staff export leaves out cost columns', () => {
  const header = X.inventoryCsv(state, names).slice(1).split('\r\n')[0];
  assert.doesNotMatch(header, /成本|庫存金額|員工價/);
  assert.match(header, /售價,特價,會員價,庫存/, '店員看得到特價、會員價');
  assert.match(X.exportFileName(new Date('2026-11-08T17:00:00Z')), /^庫存清單_2026-11-09\.csv$/, '檔名用台灣日期');
});

test('the inventory list has an export button wired to the module', async () => {
  const [html, app] = await Promise.all(['index.html', 'app.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.match(html, /<button id="inventory-export" type="button" class="secondary">匯出 CSV<\/button>/);
  assert.match(html, /<script src="inventory-export\.js\?v=5"><\/script>/);
  assert.match(app, /const includeCost = document\.body\.dataset\.role === 'admin';/);
});
