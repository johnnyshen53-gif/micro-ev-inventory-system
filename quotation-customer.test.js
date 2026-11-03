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
  assert.deepEqual([q.customerId, q.customerName, q.customerPhone, q.plateNumber, q.total], ['', '王先生', '', '', 2900]);
  assert.equal(quote(base(), { customerId: 'c1', plateNumber: ' abc-1234 ' }).quotations[0].plateNumber, 'ABC-1234', '車號選填，存成大寫');
  assert.throws(() => quote(base(), { customerId: 'c1', plateNumber: 'A'.repeat(21) }), /車號最多 20 字/);
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
  assert.match(html, /id="quotation-vehicle-model"/);
  assert.match(app, /vehicleItemChoices\(state, modelId, category\)/);
  assert.match(app, /customerName: \$\('quotation-customer-name'\)\?\.value, customerPhone: \$\('quotation-customer-phone'\)\?\.value/);
  assert.match(cloud, /customer_id,customer_name,customer_phone,plate_number,bundle_discount,salesperson_id/);
  assert.match(cloud, /plateNumber: row\.plate_number \?\? ''/);
  assert.match(html, /<input id="quotation-plate-number" maxlength="20"/);
  assert.doesNotMatch(html, /id="quotation-plate-number"[^>]*required/, '車號不是必填');
  assert.match(app, /plateNumber: \$\('quotation-plate-number'\)\?\.value/);
  assert.match(cloud, /customerName: row\.customer_id \? customerById\.get\(row\.customer_id\)\?\.name \?\? '' : row\.customer_name \?\? ''/);
});

test('quotation item choices follow vehicle then category, listing universal and unassigned items after the vehicle', () => {
  const vespa = 'v-vespa', ninebot = 'v-nine', universal = 'v-all';
  const state = { vehicleModels: [
    { id: universal, name: '通用', isUniversal: true, active: true },
    { id: vespa, name: '小偉士', isUniversal: false, active: true },
    { id: ninebot, name: '九號', isUniversal: false, active: true },
  ], items: [
    { id: 'a', name: '小偉士後照鏡', category: '外觀元件', vehicleModelId: vespa },
    { id: 'b', name: '九號後照鏡', category: '外觀元件', vehicleModelId: ninebot },
    { id: 'c', name: '手機架', category: '外觀元件', vehicleModelId: universal },
    { id: 'd', name: '舊貼紙', category: '外觀元件', vehicleModelId: '' },
    { id: 'e', name: '小偉士輪胎', category: '機構元件', vehicleModelId: vespa },
  ] };
  const pick = (modelId, category) => JSON.parse(JSON.stringify(Inventory.vehicleItemChoices(state, modelId, category).map(choice => [choice.item.id, choice.rank])));
  assert.deepEqual(pick(vespa, '外觀元件'), [['a', 0], ['c', 1], ['d', 2]], '九號的品項不列出');
  assert.deepEqual(pick(vespa, '機構元件'), [['e', 0]]);
  assert.deepEqual(pick('', '外觀元件'), [], '沒選車種不列品項');
  assert.deepEqual(pick(vespa, ''), [], '沒選分類不列品項');
  // 還沒建立任何車種：不篩車種。
  assert.deepEqual(JSON.parse(JSON.stringify(Inventory.vehicleItemChoices({ vehicleModels: [], items: state.items }, '', '機構元件').map(choice => choice.item.id))), ['e']);
});

test('quotations show each line\'s vehicle model, and the record list joins the distinct ones', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const ctx = { state: { vehicleModels: [{ id: 'u', name: '通用', isUniversal: true }, { id: 'v', name: '小偉士' }, { id: 'n', name: '九號' }],
    items: [{ id: 'a', vehicleModelId: 'v' }, { id: 'b', vehicleModelId: 'u' }, { id: 'c', vehicleModelId: '' }, { id: 'd', vehicleModelId: 'n' }] },
    vehicleModelName: Inventory.vehicleModelName };
  vm.runInNewContext(app.slice(app.indexOf('function quotationItemVehicle('), app.indexOf('function renderQuotations()')), ctx);
  assert.deepEqual(['a', 'b', 'c'].map(ctx.quotationItemVehicle), ['小偉士', '通用', '—']);
  const q = ids => ({ lines: ids.map(itemId => ({ itemId })) });
  assert.equal(ctx.quotationVehicles(q(['a', 'b', 'c'])), '小偉士', '有指定車種時不列「通用」');
  assert.equal(ctx.quotationVehicles(q(['a', 'd', 'a'])), '小偉士、九號');
  assert.equal(ctx.quotationVehicles(q(['b'])), '通用');
  assert.equal(ctx.quotationVehicles(q(['c'])), '—');
  assert.match(html, /<th>品項<\/th><th>車種<\/th><th>庫存<\/th>/);
  assert.match(html, /<th>客戶<\/th><th>車種<\/th><th>業務<\/th>/);
  assert.match(app, /table\.innerHTML = `<thead><tr><th>品項<\/th><th>車種<\/th>/);
});

test('the printed quotation header has customer and phone, date, and salesperson on separate lines', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function showQuotation(');
  const node = () => ({ children: [], dataset: {}, hidden: true, textContent: '', innerHTML: '', append(...kids) { this.children.push(...kids); }, replaceChildren() { this.children = []; } });
  const els = {};
  const ctx = { $: id => (els[id] ??= node()), document: { createElement: node }, formatNumber: String, quotationItemVehicle: () => '—' };
  vm.runInNewContext(app.slice(start, app.indexOf("\n$('", start)), ctx);
  const base = { number: 'Q1', createdAt: '2026-11-03T02:00:00.000Z', salespersonName: '阿明', lines: [], promotions: [], total: 0 };
  ctx.showQuotation({ ...base, customerName: '王先生', customerPhone: '0922333444', plateNumber: 'ABC-1234' });
  assert.equal(els['quotation-print-content'].children[0].textContent, '電小二冬山店');
  assert.equal(els['quotation-print-content'].children[1].textContent, '報價單　編號：Q1');
  const header = els['quotation-print-content'].children[2];
  assert.deepEqual(header.children.map(line => line.textContent), ['客戶：王先生　電話：0922333444　車號：ABC-1234', `日期：${new Date(base.createdAt).toLocaleDateString('zh-TW')}`, '業務：阿明']);
  ctx.showQuotation({ ...base, customerName: '李小姐', customerPhone: '', salespersonName: '' });
  assert.deepEqual(els['quotation-print-content'].children[2].children.map(line => line.textContent).filter((_, i) => i !== 1), ['客戶：李小姐', '業務：未填寫']);
});

test('managers can delete a quotation; the cloud save calls delete_quotation', async () => {
  const state = quote(base(), { customerId: '', customerName: '王先生' });
  const id = state.quotations[0].id;
  assert.equal(Inventory.deleteQuotation(state, id).quotations.length, 0);
  assert.throws(() => Inventory.deleteQuotation(state, 'missing'), /找不到報價單/);
  const [app, cloud] = await Promise.all(['app.js', 'cloud-data.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.match(cloud, /client\.rpc\('delete_quotation', \{ p_quotation_id: quotation\.id \}\)/);
  assert.match(cloud, /delete_quotation: \['quotations', 'quotationLines'\]/);
  // 刪除按鈕只給店長；按下要先確認。
  assert.match(app, /if \(document\.body\.dataset\.role === 'admin'\) \{ const remove = document\.createElement\('button'\);/);
  assert.match(app, /confirm\(`確定刪除報價單 \$\{target\.number\}/);
});

test('the printed quotation can carry the quotation stamp next to the total, switched by a checkbox', async () => {
  const [app, html, css] = await Promise.all(['app.js', 'index.html', 'style.css'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.match(html, /<input id="quotation-stamp-toggle" type="checkbox" checked> 蓋報價專用章/);
  const start = app.indexOf('function showQuotation(');
  const node = () => ({ children: [], dataset: {}, hidden: false, textContent: '', innerHTML: '', append(...kids) { this.children.push(...kids); }, replaceChildren() { this.children = []; } });
  const els = {};
  const ctx = { $: id => (els[id] ??= node()), document: { createElement: node }, formatNumber: String, quotationItemVehicle: () => '—' };
  vm.runInNewContext(app.slice(start, app.indexOf("\n$('", start)), ctx);
  const q = { number: 'Q1', createdAt: '2026-11-03T02:00:00.000Z', customerName: '王', customerPhone: '', salespersonName: '', lines: [], promotions: [], total: 2900 };
  els['quotation-stamp-toggle'] = { checked: true };
  ctx.showQuotation(q);
  const totalRow = els['quotation-print-content'].children.at(-1);
  assert.equal(totalRow.children[0].textContent, '合計：2900');
  assert.equal(totalRow.children[1].src, 'assets/quotation-stamp.png');
  assert.equal(totalRow.children[1].hidden, false);
  els['quotation-stamp-toggle'].checked = false;
  ctx.showQuotation(q);
  assert.equal(els['quotation-print-content'].children.at(-1).children[1].hidden, true, '沒勾就不蓋章');
  assert.match(css, /\.quotation-stamp \{ position: absolute; right: 0;/);
  assert.match(css, /print-color-adjust: exact/);
});
