import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 優惠代碼：前端計算必須和資料庫（supabase/tests/coupons.test.sql）算出一樣的數字。
const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const Inventory = context.window.Inventory;
const uiContext = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(await readFile(new URL('./coupons-ui.js', import.meta.url), 'utf8'), uiContext);
const CouponUI = uiContext.window.CouponUI;
const plain = value => JSON.parse(JSON.stringify(value));

const cam = 'a0000000-0000-4000-8000-000000000031', tire = 'a0000000-0000-4000-8000-000000000032', mirror = 'a0000000-0000-4000-8000-000000000033';
const oct10 = { code: 'OCT10', kind: 'percent', value: 10 };

test('percent coupons floor to whole dollars and amount coupons never go below zero', () => {
  assert.equal(Inventory.couponDiscountCents(oct10, 145000), 14500);
  assert.equal(Inventory.couponDiscountCents(oct10, 99999), 9900);
  assert.equal(Inventory.couponDiscountCents({ kind: 'percent', value: 12.5 }, 100000), 12500);
  assert.equal(Inventory.couponDiscountCents({ kind: 'amount', value: 500 }, 80000), 50000);
  assert.equal(Inventory.couponDiscountCents({ kind: 'amount', value: 500 }, 30000), 30000);
  assert.equal(Inventory.couponDiscountCents(null, 30000), 0);
  assert.deepEqual([Inventory.couponLabel(oct10), Inventory.couponLabel({ kind: 'percent', value: 15 }), Inventory.couponLabel({ kind: 'amount', value: 500 })], ['9 折', '8.5 折', '折 NT$ 500']);
});

test('combo first, then coupon on what is left — same numbers as the database test', () => {
  const state = Inventory.validateState({ ...Inventory.emptyState(),
    items: [
      { id: cam, name: '行車記錄器', category: '電控元件', sku: '22001', barcode: '22001', price: 6550, cost: 0, stock: 3, minimumStock: 0, warrantyMonths: 0 },
      { id: tire, name: '輪胎', category: '機構元件', sku: '33001', barcode: '33001', price: 1450, cost: 0, stock: 3, minimumStock: 0, warrantyMonths: 0 },
      { id: mirror, name: '後照鏡', category: '外觀元件', sku: '44001', barcode: '44001', price: 800, cost: 0, stock: 3, minimumStock: 0, warrantyMonths: 0 },
    ],
    salespeople: [{ id: 's1', name: '業務', active: true, isSales: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }] });
  const promoA = { id: 'pa', name: 'A', comboPrice: 8000, active: true, startsOn: '2026-10-01', endsOn: '2026-10-31',
    items: [{ itemId: cam, quantity: 1 }, { itemId: tire, quantity: 1 }, { itemId: mirror, quantity: 1 }] };
  const sales = Inventory.recordSaleBatch(state, { salespersonId: 's1', promotions: [{ promotion: promoA, times: 1 }], coupon: oct10,
    lines: [{ itemId: cam, quantity: 1 }, { itemId: tire, quantity: 1 }, { itemId: mirror, quantity: 1 }] }).sales;
  assert.deepEqual(plain(sales.map(sale => [sale.discount, sale.subtotal])), [[1194, 5356], [262, 1188], [144, 656]]);
  assert.equal(sales.reduce((sum, sale) => sum + sale.subtotal, 0), 7200);
  assert.equal(sales[0].couponCode, 'OCT10');
  const only = Inventory.recordSaleBatch(state, { salespersonId: 's1', coupon: { code: 'VIP500', kind: 'amount', value: 500 }, lines: [{ itemId: mirror, quantity: 1 }] }).sales[0];
  assert.deepEqual(plain([only.discount, only.subtotal]), [500, 300]);
});

test('coupon admin helpers: code format and status', () => {
  assert.equal(CouponUI.normalizeCode(' oct10 '), 'OCT10');
  assert.equal(CouponUI.validCode('OCT10'), true);
  assert.equal(CouponUI.validCode('A B'), false);
  assert.equal(CouponUI.validCode('AB'), false);
  const base = { active: true, startsOn: '2026-10-01', endsOn: '2026-10-31', usageLimit: 2, usedCount: 0 };
  assert.equal(CouponUI.couponStatus(base, '2026-10-15').label, '進行中');
  assert.equal(CouponUI.couponStatus({ ...base, usedCount: 2 }, '2026-10-15').label, '已用完');
  assert.equal(CouponUI.couponStatus({ ...base, usageLimit: null, usedCount: 99 }, '2026-10-15').label, '進行中');
  assert.equal(CouponUI.couponStatus(base, '2026-11-01').label, '已過期');
  assert.equal(CouponUI.couponStatus({ ...base, active: false }, '2026-10-15').label, '已停用');
  assert.match(CouponUI.valueHint('percent', '10'), /打 9 折：NT\$ 1,000 收 NT\$ 900/);
});

test('coupon code box sits in checkout and the admin list lives on the 優惠設定 page', async () => {
  const [html, app, cloud] = await Promise.all(['index.html', 'app.js', 'cloud-data.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  for (const id of ['sale-promo-coupon-code', 'sale-promo-coupon-apply', 'sale-cart-coupon-row', 'sale-cart-coupon', 'coupon-form', 'coupon-code', 'coupon-kind', 'coupon-value', 'coupon-limit', 'coupon-list', 'coupon-status']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<label for="sale-promo-coupon-code">優惠代碼<\/label>/);
  assert.match(html, /<script src="coupons-ui\.js\?v=\d+"><\/script>/);
  assert.match(app, /coupon: window\.PromotionUI\?\.checkout\?\.coupon\(\) \?\? null/);
  assert.match(app, /coupons: true,/);
  assert.match(cloud, /rpc\('check_coupon', \{ p_code: code \}\)/);
});
