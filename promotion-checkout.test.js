import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 特惠組合結帳：前端的折扣計算必須和資料庫（supabase/tests/promotion_checkout.test.sql）算出一樣的數字。
const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const Inventory = context.window.Inventory;
const plain = value => JSON.parse(JSON.stringify(value));

const cam = 'a0000000-0000-4000-8000-000000000031', tire = 'a0000000-0000-4000-8000-000000000032', mirror = 'a0000000-0000-4000-8000-000000000033';
const promoA = { id: 'pa', name: 'A 保養組', comboPrice: 8000, active: true, startsOn: '2026-10-01', endsOn: '2026-10-31',
  items: [{ itemId: cam, quantity: 1 }, { itemId: tire, quantity: 1 }, { itemId: mirror, quantity: 1 }] };
const promoB = { id: 'pb', name: 'B 輪胎組', comboPrice: 2500, active: true, startsOn: '2026-10-01', endsOn: '2026-10-31',
  items: [{ itemId: tire, quantity: 2 }] };
const cart = (tires = 1) => [{ itemId: cam, unitPrice: 6550, quantity: 1 }, { itemId: tire, unitPrice: 1450, quantity: tires }, { itemId: mirror, unitPrice: 800, quantity: 1 }];

test('combo discount is split by share, floored to whole dollars, remainder on the largest line', () => {
  const result = Inventory.promotionDiscounts(cart(), [{ promotion: promoA, times: 1 }]);
  assert.equal(result.total, 800);
  assert.deepEqual(plain([...result.byItem]), [[cam, 59700], [tire, 13100], [mirror, 7200]]);
  assert.deepEqual(plain(result.entries), [{ promotionId: 'pa', name: 'A 保養組', times: 1, listTotal: 8800, discount: 800 }]);
});

test('several combos and repeated sets add up per item and need enough quantity', () => {
  const result = Inventory.promotionDiscounts(cart(5), [{ promotion: promoA, times: 1 }, { promotion: promoB, times: 2 }]);
  assert.equal(result.total, 1600);
  assert.equal(result.byItem.get(tire), 93100);
  assert.throws(() => Inventory.promotionDiscounts(cart(4), [{ promotion: promoA, times: 1 }, { promotion: promoB, times: 2 }]), /數量不足/);
  assert.throws(() => Inventory.promotionDiscounts(cart(), [{ promotion: promoA, times: 0 }]), /1～99/);
  assert.throws(() => Inventory.promotionDiscounts([{ itemId: cam, unitPrice: 6550, quantity: 1 }], [{ promotion: promoA, times: 1 }]), /缺少/);
  assert.throws(() => Inventory.promotionDiscounts(cart(), [{ promotion: promoA, times: 1 }, { promotion: promoA, times: 1 }]), /組數表示/);
  // 原價被調低後組合價不再划算：不能套用。
  assert.throws(() => Inventory.promotionDiscounts([{ itemId: tire, unitPrice: 1000, quantity: 2 }], [{ promotion: promoB, times: 1 }]), /已不高於組合價/);
});

test('allocation never pushes a line below zero even for a near-free combo', () => {
  // 組合價 0 元、單價帶角：捨去到元後最大項放不下，多出的部分要往後補，每一項最多扣到 0。
  const parts = ['x', 'y', 'z'].map(itemId => ({ itemId, grossCents: 10099 }));
  assert.deepEqual(plain([...Inventory.allocatePromotionDiscount(parts, 30297)]), [['x', 10099], ['y', 10099], ['z', 10099]]);
  const normal = Inventory.allocatePromotionDiscount([{ itemId: 'x', grossCents: 10050 }, { itemId: 'y', grossCents: 10049 }, { itemId: 'z', grossCents: 10049 }], 30048);
  assert.deepEqual(plain([...normal]), [['x', 10048], ['y', 10000], ['z', 10000]]);
});

test('fit times counts only what is left after combos already applied', () => {
  assert.equal(Inventory.promotionFitTimes(cart(5), [], promoB), 2);
  assert.equal(Inventory.promotionFitTimes(cart(5), [{ promotion: promoA, times: 1 }], promoB), 2);
  assert.equal(Inventory.promotionFitTimes(cart(4), [{ promotion: promoA, times: 1 }], promoB), 1);
  assert.equal(Inventory.promotionFitTimes(cart(1), [{ promotion: promoA, times: 1 }], promoA), 0);
  assert.equal(Inventory.promotionInPeriod(promoA, '2026-10-31'), true);
  assert.equal(Inventory.promotionInPeriod(promoA, '2026-11-01'), false);
  assert.equal(Inventory.promotionInPeriod({ ...promoA, active: false }, '2026-10-15'), false);
});

test('checkout stores net subtotals, the discount and the applied combos on each sale line', () => {
  const state = Inventory.validateState({ ...Inventory.emptyState(),
    items: [
      { id: cam, name: '行車記錄器', category: '電控元件', sku: '22001', barcode: '22001', price: 6550, cost: 0, stock: 3, minimumStock: 0, warrantyMonths: 0 },
      { id: tire, name: '輪胎', category: '機構元件', sku: '33001', barcode: '33001', price: 1450, cost: 0, stock: 3, minimumStock: 0, warrantyMonths: 0 },
      { id: mirror, name: '後照鏡', category: '外觀元件', sku: '44001', barcode: '44001', price: 800, cost: 0, stock: 3, minimumStock: 0, warrantyMonths: 0 },
    ],
    salespeople: [{ id: 's1', name: '業務', active: true, isSales: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }] });
  const next = Inventory.recordSaleBatch(state, { salespersonId: 's1', promotions: [{ promotion: promoA, times: 1 }],
    lines: [{ itemId: cam, quantity: 1 }, { itemId: tire, quantity: 1 }, { itemId: mirror, quantity: 1 }] });
  const sales = next.sales;
  assert.deepEqual(plain(sales.map(sale => [sale.unitPrice, sale.discount, sale.subtotal])), [[6550, 597, 5953], [1450, 131, 1319], [800, 72, 728]]);
  assert.equal(sales.reduce((sum, sale) => sum + sale.subtotal, 0), 8000);
  assert.deepEqual(plain(sales[0].promotions), [{ promotionId: 'pa', times: 1 }]);
  // 沒套組合：和以前一樣原價。
  const plainSale = Inventory.recordSaleBatch(state, { salespersonId: 's1', lines: [{ itemId: mirror, quantity: 2 }] }).sales[0];
  assert.deepEqual(plain([plainSale.discount, plainSale.subtotal, plainSale.promotions.length]), [0, 1600, 0]);
});

test('checkout sends combos to the database and the sales page has the combo area', async () => {
  const [cloud, html, app, ui] = await Promise.all(['cloud-data.js', 'index.html', 'app.js', 'promotions-ui.js']
    .map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.match(cloud, /p_checkout_id: checkoutId, p_promotions: addedSales\[0\]\.promotions \?\? \[\] \}/);
  assert.match(cloud, /unit_price,discount,subtotal/);
  assert.match(cloud, /sale_promotions\(times,discount\)/);
  for (const id of ['sale-promo-panel', 'sale-promo-suggestions', 'sale-promo-applied', 'sale-promo-select', 'sale-promo-add', 'sale-promo-hint', 'sale-cart-breakdown', 'sale-cart-gross', 'sale-cart-discount']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<label for="sale-promo-select">特惠組合<\/label>/);
  assert.match(app, /promotions: window\.PromotionUI\?\.checkout\?\.selected\(\) \?\? \[\]/);
  assert.match(app, /if \(page === 'sales'\) window\.PromotionUI\?\.checkout\?\.load\(\);/);
  assert.match(app, /window\.PromotionUI\?\.checkout\?\.clear\(\);/);
  assert.match(ui, /mountCheckout/);
});
