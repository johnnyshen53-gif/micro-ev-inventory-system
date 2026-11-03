import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 車身＋電池組合折扣：每 1 車身＋1 電池折 500；先組合、再車身電池、最後優惠代碼（數字和 supabase/tests/bundle_discount.test.sql 相同）。
const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const I = context.window.Inventory;
const plain = value => JSON.parse(JSON.stringify(value));

const ready = () => {
  let state = I.emptyState();
  state = I.addItem(state, { name: '小偉士', category: '車身', price: 30000, cost: 0, stock: 10, minimumStock: 0, warrantyMonths: 0 });
  state = I.addItem(state, { name: '鋰電池', category: '電池', voltage: 48, capacity: 20, price: 5000, cost: 0, stock: 10, minimumStock: 0, warrantyMonths: 0 });
  state = I.addItem(state, { name: '安全帽', category: '外觀元件', price: 800, cost: 0, stock: 10, minimumStock: 0, warrantyMonths: 0 });
  state = I.addSalesperson(state, { name: '業務' });
  state = I.addCustomer(state, { name: '王先生', phone: '0911000000' });
  return state;
};
const ids = state => Object.fromEntries(state.items.map(item => [item.category, item.id]));
const sell = (state, lines, extra = {}) => I.recordSaleBatch(state, { salespersonId: state.salespeople[0].id, lines, ...extra });

test('the calculator pairs one body with one battery per 500 and takes it from the body first', () => {
  const state = ready(), id = ids(state);
  const calc = lines => plain((({ sets, total, byItem }) => ({ sets, total, byItem: [...byItem] }))(I.bundleDiscounts(lines, state.items)));
  assert.deepEqual(calc([{ itemId: id['車身'], quantity: 1, netCents: 3000000 }, { itemId: id['電池'], quantity: 1, netCents: 500000 }]),
    { sets: 1, total: 500, byItem: [[id['車身'], 50000]] });
  assert.equal(calc([{ itemId: id['車身'], quantity: 2, netCents: 6000000 }, { itemId: id['電池'], quantity: 1, netCents: 500000 }]).total, 500);
  assert.equal(calc([{ itemId: id['車身'], quantity: 2, netCents: 6000000 }, { itemId: id['電池'], quantity: 2, netCents: 1000000 }]).total, 1000);
  assert.equal(calc([{ itemId: id['車身'], quantity: 1, netCents: 3000000 }, { itemId: id['外觀元件'], quantity: 3, netCents: 240000 }]).total, 0);
  // 車身金額不夠扣時，剩下的從電池扣。
  assert.deepEqual(calc([{ itemId: id['車身'], quantity: 1, netCents: 20000 }, { itemId: id['電池'], quantity: 1, netCents: 500000 }]).byItem,
    [[id['車身'], 20000], [id['電池'], 30000]]);
});

test('checkout applies the bundle discount automatically, before a coupon', () => {
  const state = ready(), id = ids(state);
  const sold = sell(state, [{ itemId: id['車身'], quantity: 1 }, { itemId: id['電池'], quantity: 1 }]);
  assert.deepEqual(plain(sold.sales.map(sale => [sale.discount, sale.subtotal])), [[500, 29500], [0, 5000]]);
  const two = sell(state, [{ itemId: id['車身'], quantity: 2 }, { itemId: id['電池'], quantity: 1 }]);
  assert.equal(two.sales.reduce((sum, sale) => sum + sale.subtotal, 0), 64500);
  const none = sell(state, [{ itemId: id['車身'], quantity: 1 }, { itemId: id['外觀元件'], quantity: 1 }]);
  assert.equal(none.sales.reduce((sum, sale) => sum + sale.subtotal, 0), 30800);
  // 優惠代碼 10%：(35000 − 500) × 10% ＝ 3450，實收 31050。
  const coupon = sell(state, [{ itemId: id['車身'], quantity: 1 }, { itemId: id['電池'], quantity: 1 }], { coupon: { code: 'BD10', kind: 'percent', value: 10 } });
  assert.equal(coupon.sales.reduce((sum, sale) => sum + sale.subtotal, 0), 31050);
});

test('quotations get the same discount and remember it', () => {
  const state = ready(), id = ids(state);
  const next = I.createQuotation(state, { customerId: state.customers[0].id, salespersonId: state.salespeople[0].id,
    lines: [{ itemId: id['車身'], quantity: 1 }, { itemId: id['電池'], quantity: 1 }] });
  const q = next.quotations[0];
  assert.deepEqual(plain([q.total, q.bundleDiscount, q.lines[0].discount, q.lines[1].discount]), [34500, 500, 500, 0]);
  assert.equal(I.validateState(next).quotations[0].bundleDiscount, 500);
});

test('the checkout and quotation screens show the bundle discount', async () => {
  const [html, app, ui, cloud] = await Promise.all(['index.html', 'app.js', 'promotions-ui.js', 'cloud-data.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.match(html, /<div id="sale-cart-bundle-row" hidden><dt>車身＋電池折扣<\/dt>/);
  assert.match(ui, /bundleDiscount: bundle\.total/);
  assert.match(app, /\$\('sale-cart-bundle-row'\)\.hidden = !bundleDiscount/);
  assert.match(app, /車身＋電池折扣：−\$\{formatNumber\(quotation\.bundleDiscount \?\? 0\)\}/);
  assert.match(cloud, /bundleDiscount: Number\(row\.bundle_discount \?\? 0\)/);
});
