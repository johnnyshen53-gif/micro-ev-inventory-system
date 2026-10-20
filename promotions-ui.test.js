import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const context = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(await readFile(new URL('./promotions-ui.js', import.meta.url), 'utf8'), context);
const { promotionStatus, listTotal, summary, nextMonthCopy, currentMonthRange } = context.window.PromotionUI;

const items = [{ id: 'bat', price: 12000 }, { id: 'tire', price: 1450 }, { id: 'cam', price: 6550.5 }];

test('promotion status counts both start and end day and lets inactive win', () => {
  const promo = { active: true, startsOn: '2026-10-01', endsOn: '2026-10-31' };
  assert.equal(promotionStatus(promo, '2026-09-30').key, 'upcoming');
  assert.equal(promotionStatus(promo, '2026-10-01').key, 'active');
  assert.equal(promotionStatus(promo, '2026-10-31').key, 'active');
  assert.equal(promotionStatus(promo, '2026-11-01').key, 'expired');
  assert.equal(promotionStatus({ ...promo, active: false }, '2026-10-15').label, '已停用');
});

test('list total and discount use current prices without floating point drift', () => {
  const lines = [{ itemId: 'bat', quantity: 1 }, { itemId: 'tire', quantity: 2 }, { itemId: 'cam', quantity: 1 }];
  assert.equal(listTotal(lines, items), 21450.5);
  const result = summary(lines, items, '20000');
  assert.equal(result.discount, 1450.5);
  assert.equal(result.pieces, 4);
  assert.ok(Math.abs(result.rate - 1450.5 / 21450.5) < 1e-12);
  assert.equal(listTotal([{ itemId: 'gone', quantity: 1 }], items), null);
  assert.equal(summary(lines, items, '').discount, null);
});

test('copying to next month moves the period and the month in the name', () => {
  const copy = nextMonthCopy({ id: 'x', name: '10 月換電池保養組', startsOn: '2026-10-01', endsOn: '2026-10-31', comboPrice: 18800, active: false, items: [{ itemId: 'bat', quantity: 1 }] });
  assert.equal(copy.id, '');
  assert.equal(copy.name, '11 月換電池保養組');
  assert.deepEqual([copy.startsOn, copy.endsOn, copy.active], ['2026-11-01', '2026-11-30', true]);
  const december = nextMonthCopy({ name: '12月組合', startsOn: '2026-12-05', endsOn: '2026-12-20', items: [] });
  assert.deepEqual([december.name, december.startsOn, december.endsOn], ['1月組合', '2027-01-01', '2027-01-31']);
  const january = nextMonthCopy({ name: '春季組合', startsOn: '2028-01-01', endsOn: '2028-01-31', items: [] });
  assert.deepEqual([january.name, january.endsOn], ['春季組合', '2028-02-29']);
  assert.equal(JSON.stringify(currentMonthRange('2026-02-14')), JSON.stringify({ startsOn: '2026-02-01', endsOn: '2026-02-28' }));
});

test('promotions page is admin-only and loaded with the app', async () => {
  const [html, app] = await Promise.all([readFile(new URL('./index.html', import.meta.url), 'utf8'), readFile(new URL('./app.js', import.meta.url), 'utf8')]);
  assert.match(html, /<button class="page-tab" type="button" data-page-target="promotions" data-role="admin">特惠組合<\/button>/);
  assert.match(html, /<section class="app-page promotions-page" data-page="promotions" aria-label="特惠組合" data-role="admin" hidden>/);
  assert.match(html, /<script src="promotions-ui\.js\?v=\d+"><\/script>/);
  assert.match(app, /if \(page === 'promotions'\) window\.PromotionUI\?\.instance\?\.load\(\);/);
  assert.match(app, /window\.PromotionUI\?\.instance\?\.clear\(\);/);
});
