// 特價／會員價／員工價：品項多三個選填價格，結帳時每個品項可以選用哪一種價格計價。
// 空白＝沒有設定（不能選）；0＝0 元。員工價只有店長看得到、能選（數字和 supabase/tests/price_tiers.test.sql 相同）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = file => readFile(new URL(`./${file}`, import.meta.url), 'utf8');
const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await read('inventory.js'), context);
const I = context.window.Inventory;
const plain = value => JSON.parse(JSON.stringify(value));

const ready = () => {
  let state = I.addCustomer(I.emptyState(), { name: '會員王先生', phone: '0900000001' });
  state = I.addItem(state, { name: '座墊', category: '外觀元件', price: 950, specialPrice: '849', memberPrice: 799, staffPrice: 600, cost: 500, stock: 20, minimumStock: 0 });
  state = I.addItem(state, { name: '腳踏板', category: '外觀元件', price: 1100, specialPrice: '', memberPrice: 0, cost: 0, stock: 20, minimumStock: 0 });
  state = I.addItem(state, { name: '小偉士', category: '車身', price: 30000, specialPrice: 28000, cost: 0, stock: 5, minimumStock: 0 });
  state = I.addItem(state, { name: '鋰電池', category: '電池', voltage: 48, capacity: 20, price: 5000, cost: 0, stock: 5, minimumStock: 0 });
  return I.addSalesperson(state, { name: '業務' });
};
const sell = (state, lines, customerId = '') => I.recordSaleBatch(state, { salespersonId: state.salespeople[0].id, customerId, lines });

test('items keep three optional prices: blank means not set, zero means free, negatives are rejected', () => {
  const [seat, step] = ready().items;
  assert.deepEqual(plain([seat.specialPrice, seat.memberPrice, seat.staffPrice]), [849, 799, 600]);
  assert.deepEqual(plain([step.specialPrice, step.memberPrice, step.staffPrice]), [null, 0, null]);
  assert.throws(() => I.addItem(I.emptyState(), { name: 'x', category: '外觀元件', price: 1, memberPrice: -1, cost: 0, stock: 0, minimumStock: 0 }), /會員價必須是零或正數/);
  assert.equal(I.tierPrice(seat, 'regular'), 950);
  assert.equal(I.tierPrice(step, 'special'), null);
  assert.equal(I.tierPrice(step, 'member'), 0);
  assert.throws(() => I.tierPrice(seat, 'vip'), /價格別無效/);
});

test('checkout choices list only the prices that are set; the staff price is for the manager only', () => {
  const [seat, step] = ready().items;
  assert.deepEqual(plain(I.priceTierChoices(seat).map(choice => [choice.tier, choice.label, choice.price])), [['regular', '售價', 950], ['special', '特價', 849], ['member', '會員價', 799]]);
  assert.deepEqual(plain(I.priceTierChoices(seat, { admin: true }).map(choice => choice.tier)), ['regular', 'special', 'member', 'staff']);
  assert.deepEqual(plain(I.priceTierChoices(step, { admin: true }).map(choice => [choice.tier, choice.price])), [['regular', 1100], ['member', 0]]);
});

test('a sale uses the chosen price for each line and records which price it was', () => {
  const state = ready(), [seat, step] = state.items;
  const next = sell(state, [{ itemId: seat.id, quantity: 2, priceTier: 'special' }, { itemId: step.id, quantity: 1, priceTier: 'member' }], state.customers[0].id);
  assert.deepEqual(plain(next.sales.map(sale => [sale.itemName, sale.priceTier, sale.unitPrice, sale.subtotal])), [['座墊', 'special', 849, 1698], ['腳踏板', 'member', 0, 0]]);
  assert.equal(next.items[0].stock, 18);
  const regular = sell(state, [{ itemId: seat.id, quantity: 1 }]).sales[0];
  assert.deepEqual([regular.priceTier, regular.unitPrice], ['regular', 950]);
  assert.equal(sell(state, [{ itemId: seat.id, quantity: 3, priceTier: 'staff' }]).sales[0].subtotal, 1800);
  assert.throws(() => sell(state, [{ itemId: step.id, quantity: 1, priceTier: 'special' }]), /「腳踏板」沒有設定特價/);
  assert.throws(() => sell(state, [{ itemId: seat.id, quantity: 1, priceTier: 'member' }]), /會員價需要先選擇客戶/, '沒選客戶不能用會員價');
  assert.throws(() => sell(state, [{ itemId: step.id, quantity: 1, priceTier: 'staff' }]), /「腳踏板」沒有設定員工價/);
});

test('discounts are worked out from the chosen price (body + battery still takes 500 off)', () => {
  const state = ready(), body = state.items[2], battery = state.items[3];
  const sales = sell(state, [{ itemId: body.id, quantity: 1, priceTier: 'special' }, { itemId: battery.id, quantity: 1 }]).sales;
  assert.deepEqual(plain(sales.map(sale => [sale.unitPrice, sale.discount, sale.subtotal])), [[28000, 500, 27500], [5000, 0, 5000]]);
});

test('editing an item can set and clear the three prices', () => {
  const state = ready(), seat = state.items[0];
  const next = I.updateItem(state, seat.id, { ...seat, specialPrice: '', memberPrice: '0', staffPrice: 650 }).items[0];
  assert.deepEqual(plain([next.specialPrice, next.memberPrice, next.staffPrice]), [null, 0, 650]);
});

test('CSV import reads the three price columns; blank stays not set', async () => {
  const importContext = { window: {}, document: { getElementById: () => null } };
  vm.runInNewContext(await read('item-import.js'), importContext);
  const X = importContext.window.ItemImport;
  assert.match(X.templateCsv(), /售價,特價,會員價,員工價,/);
  const csv = '品項名稱,分類,車種,售價,特價,會員價,員工價\n座墊,外觀元件,,950,849,,0\n後架,機構元件,,1380,abc,,\n';
  const preview = X.buildPreview(I.emptyState(), csv, { inventory: I });
  assert.deepEqual(plain(preview.rows.map(row => row.errors)), [[], ['特價必須是數字']]);
  const ok = X.buildPreview(I.emptyState(), csv.split('\n').slice(0, 2).join('\n'), { inventory: I });
  assert.deepEqual(plain((({ specialPrice, memberPrice, staffPrice }) => [specialPrice, memberPrice, staffPrice])(ok.nextState.items[0])), [849, null, 0]);
});

// 購物車：有設定其他價格的品項，單價下面出現選單；改選後單價、小計跟著變。
function cart(role) {
  const nodes = new Map();
  const node = () => ({ value: '', children: [], dataset: {}, listeners: {}, attributes: {}, replaceChildren() { this.children = []; this.value = ''; }, append(...c) { this.children.push(...c); },
    get lastChild() { return this.children.at(-1); }, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {} });
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const ctx = { $, document: { createElement: node, body: { dataset: { role } } }, Option: function (text, value) { return { text, value }; }, formatNumber: String,
    showFormError: (_, message) => { ctx.error = message; }, clearFormError() {}, state: { ...ready(), serials: [] }, saleCart: [], saleCheckoutId: 'old', saleSerialItemId: '', saleSerialQuantity: 1 };
  vm.createContext(ctx);
  Object.assign(ctx, { requiresSerial: I.requiresSerial, priceTierChoices: I.priceTierChoices, tierPrice: I.tierPrice });
  return ctx;
}
test('the cart offers a price picker per line and re-prices the line when it changes', async () => {
  const app = await read('app.js');
  const ctx = cart('clerk');
  vm.runInContext(app.slice(app.indexOf('function parseUnitQr('), app.indexOf("$('item-search')?.addEventListener('input', renderItems);")), ctx);
  vm.runInContext(app.slice(app.indexOf('function renderSalePicker()'), app.indexOf("if ($('sale-form'))")), ctx);
  const [seat, , , battery] = ctx.state.items;
  vm.runInContext(`addSaleItem(state.items[0], 2); addSaleItem(state.items[3], 1);`, ctx);
  const rows = () => ctx.$('sale-cart').children;
  const picker = row => row.children[1].children.find(child => child.dataset?.saleTier !== undefined);
  assert.deepEqual(plain(picker(rows()[0]).children), [{ text: '售價 950', value: 'regular' }, { text: '特價 849', value: 'special' }, { text: '會員價 799', value: 'member' }], '店員看不到員工價');
  assert.equal(picker(rows()[1]), undefined, `${battery.name} 只有售價，不出現選單`);
  // 沒選客戶：不能換成會員價，維持售價並提示。
  let select = picker(rows()[0]); select.value = 'member';
  ctx.$('sale-cart').listeners.change({ target: { closest: () => select } });
  assert.match(ctx.error, /會員價需要先選擇客戶/);
  assert.deepEqual(plain(vm.runInContext('[saleCart[0].priceTier, saleCart[0].unitPrice]', ctx)), ['regular', 950]);
  // 選了客戶就可以。
  ctx.$('sale-customer').value = ctx.state.customers[0].id;
  select = picker(rows()[0]); select.value = 'member';
  ctx.$('sale-cart').listeners.change({ target: { closest: () => select } });
  assert.deepEqual(plain(vm.runInContext('[saleCart[0].priceTier, saleCart[0].unitPrice, saleCart[0].subtotal, saleCheckoutId]', ctx)), ['member', 799, 1598, '']);
  assert.equal(picker(rows()[0]).value, 'member');
  assert.equal(ctx.$('sale-cart-total').textContent, String(1598 + 5000));
  assert.equal(seat.price, 950);
  // 客戶改回「不選」：會員價的品項自動改回售價。
  ctx.$('sale-customer').value = '';
  ctx.$('sale-customer').listeners.change();
  assert.deepEqual(plain(vm.runInContext('[saleCart[0].priceTier, saleCart[0].unitPrice, saleCart[0].subtotal]', ctx)), ['regular', 950, 1900]);
  assert.match(ctx.error, /已改回售價/);

  const admin = cart('admin');
  vm.runInContext(app.slice(app.indexOf('function parseUnitQr('), app.indexOf("$('item-search')?.addEventListener('input', renderItems);")), admin);
  vm.runInContext(app.slice(app.indexOf('function renderSalePicker()'), app.indexOf("if ($('sale-form'))")), admin);
  vm.runInContext(`addSaleItem(state.items[0], 1);`, admin);
  assert.deepEqual(plain(admin.$('sale-cart').children[0].children[1].children.find(child => child.dataset?.saleTier !== undefined).children.map(option => option.value)), ['regular', 'special', 'member', 'staff']);
});

test('the three prices are stored, loaded and sent to checkout; the staff price lives with the cost', async () => {
  const [cloud, html, app, migration] = await Promise.all(['cloud-data.js', 'index.html', 'app.js', 'supabase/migrations/20261109010000_price_tiers.sql'].map(read));
  assert.match(cloud, /fields: 'id,name,category,sku,barcode,price,special_price,member_price,price_changed_at,/);
  assert.match(cloud, /fields: 'item_id,cost,staff_price', adminOnly: true/);
  assert.match(cloud, /special_price: item\.specialPrice \?\? null, member_price: item\.memberPrice \?\? null/);
  assert.match(cloud, /price_tier: value\.priceTier \|\| 'regular'/);
  assert.match(cloud, /\{ item_id: value\.id, staff_price: value\.staffPrice \?\? null \}/);
  assert.doesNotMatch(cloud.match(/const itemRow = .*/)[0], /staff/, '員工價不寫進 items（店員讀得到的表）');
  for (const id of ['item-special-price', 'item-member-price', 'item-staff-price']) assert.match(html, new RegExp(`<input id="${id}" type="number" min="0" step="0.01"`), id);
  assert.match(app, /specialPrice: \$\('item-special-price'\)\?\.value \?\? ''/);
  assert.match(migration, /alter table public\.item_costs\s+add column staff_price/);
  assert.match(migration, /只有店長可以用員工價結帳/);
  assert.match(migration, /if p_customer_id is null then raise exception '會員價需要先選擇客戶'/);
  assert.match(migration, /price_tier in \('regular', 'special', 'member', 'staff'\)/);
});
