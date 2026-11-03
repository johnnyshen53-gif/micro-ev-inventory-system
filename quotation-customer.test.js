import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 報價單：客戶可直接填寫（只有姓名必填，不會加到客戶管理）；品項先選分類再選品名。
const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const Inventory = context.window.Inventory;
const tire = 'c0000000-0000-4000-8000-000000000001';
const base = () => Inventory.validateState({ ...Inventory.emptyState(),
  items: [{ id: tire, name: '輪胎', category: '機構元件', sku: '33001', barcode: '33001', price: 1450, cost: 0, stock: 0, minimumStock: 0, warrantyMonths: 0 }],
  customers: [{ id: 'c1', memberNumber: 'M000001', name: '清單客戶', phone: '0911000000', address: '', note: '', active: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  salespeople: [{ id: 's1', name: '業務', active: true, isSales: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] });
const quote = (state, fields) => Inventory.createQuotation(state, { salespersonId: 's1', lines: [{ itemId: tire, quantity: 2 }], ...fields });

test('a typed-in customer is stored only on the quotation; name is required, phone is optional', () => {
  const next = quote(base(), { customerId: '', customerName: '  王先生 ', customerPhone: '' });
  const q = next.quotations[0];
  assert.deepEqual([q.customerId, q.customerName, q.customerPhone, q.total], ['', '王先生', '', 2900]);
  assert.equal(next.customers.length, 1, '不會新增到客戶管理');
  assert.equal(Inventory.validateState(next).quotations[0].customerName, '王先生');
  assert.throws(() => quote(base(), { customerId: '', customerName: '   ' }), /請選擇客戶或填寫客戶姓名/);
  assert.throws(() => quote(base(), { customerId: '', customerName: '王'.repeat(51) }), /最多 50 字/);
  // 選清單客戶：照舊帶入客戶資料。
  const listed = quote(base(), { customerId: 'c1', customerName: '不該用到' }).quotations[0];
  assert.deepEqual([listed.customerId, listed.customerName, listed.customerPhone], ['c1', '清單客戶', '0911000000']);
  assert.throws(() => Inventory.validateState({ ...next, quotations: [{ ...q, customerId: 'missing' }] }), /報價客戶不存在/);
});

test('the quotation form offers a typed-in customer and picks items by category first', async () => {
  const [html, app, cloud] = await Promise.all(['index.html', 'app.js', 'cloud-data.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  for (const id of ['quotation-walk-in', 'quotation-customer-name', 'quotation-customer-phone', 'quotation-category', 'quotation-item']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /<select id="quotation-customer" required>/);
  assert.match(app, /customer\.append\(new Option\('直接填寫客戶', ''\)\)/);
  assert.match(app, /state\.items\.filter\(\(candidate\) => candidate\.category === category\)/);
  assert.match(app, /customerName: \$\('quotation-customer-name'\)\?\.value, customerPhone: \$\('quotation-customer-phone'\)\?\.value/);
  assert.match(cloud, /customer_id,customer_name,customer_phone,salesperson_id/);
  assert.match(cloud, /customerName: row\.customer_id \? customerById\.get\(row\.customer_id\)\?\.name \?\? '' : row\.customer_name \?\? ''/);
});
