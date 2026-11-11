// 最後價格異動時間：售價、特價、會員價、員工價、成本任何一個改動就更新；改其他欄位不動。
// 既有品項沒有紀錄（空字串）；批次匯入可以帶入原資料的異動日期（規則和 supabase/tests/price_changed_at.test.sql 相同）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = file => readFile(new URL(`./${file}`, import.meta.url), 'utf8');
const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await read('inventory.js'), context);
const I = context.window.Inventory;
const OLD = '2020-01-01T00:00:00.000Z';
const base = { name: '座墊', category: '外觀元件', price: 950, specialPrice: 849, memberPrice: '', staffPrice: '', cost: 500, stock: 5, minimumStock: 0 };
// 一個價格異動時間是「過去」的品項，方便看出有沒有被更新。
const aged = () => { const state = I.addItem(I.emptyState(), { ...base, priceChangedAt: OLD }); return { state, item: state.items[0] }; };
const isNow = value => Math.abs(Date.now() - Date.parse(value)) < 5000;

test('a new item is stamped now unless a time is given; old data without a time stays blank', () => {
  assert.ok(isNow(I.addItem(I.emptyState(), base).items[0].priceChangedAt));
  assert.equal(aged().item.priceChangedAt, OLD);
  const legacy = I.validateState({ ...I.emptyState(), items: [{ ...aged().item, priceChangedAt: undefined }] }).items[0];
  assert.equal(legacy.priceChangedAt, '', '既有品項沒有紀錄');
  assert.throws(() => I.addItem(I.emptyState(), { ...base, priceChangedAt: 'not a date' }), /價格異動時間無效/);
});

test('editing name, stock or notes keeps the time; changing any price or the cost updates it', () => {
  const { state, item } = aged();
  const edit = fields => I.updateItem(state, item.id, { ...item, ...fields }).items[0].priceChangedAt;
  assert.equal(edit({ name: '座墊（黑）', notes: 'x', minimumStock: 2, stock: 9 }), OLD);
  assert.equal(edit({ price: '950', specialPrice: '849', memberPrice: '', cost: '500' }), OLD, '表單送出一樣的數字不算異動');
  for (const fields of [{ price: 990 }, { specialPrice: '' }, { memberPrice: 0 }, { staffPrice: 600 }, { cost: 520 }]) {
    assert.ok(isNow(edit(fields)), JSON.stringify(fields));
  }
});

test('receiving a purchase updates the time only when the cost changes', () => {
  const run = unitCost => {
    let state = I.addSupplier(I.emptyState(), { name: '車廠' });
    state = I.addItem(state, { ...base, supplierId: state.suppliers[0].id, priceChangedAt: OLD });
    const item = state.items[0];
    state = I.createPurchase(state, { supplierId: state.suppliers[0].id, lines: [{ itemId: item.id, quantity: 1, unitCost }] });
    return I.receivePurchase(state, state.purchases[0].id, { receivedBy: 'u' }).items[0];
  };
  assert.equal(run(500).priceChangedAt, OLD, '成本沒變');
  const changed = run(520);
  assert.equal(changed.cost, 520);
  assert.ok(isNow(changed.priceChangedAt));
});

test('times are shown in Taiwan time; no record shows nothing', () => {
  assert.equal(I.formatPriceTime('2026-11-10T17:05:00.123456+00:00'), '2026/11/11');
  assert.equal(I.formatPriceTime('2026-11-10T17:05:00Z', { time: true }), '2026/11/11 01:05');
  assert.equal(I.formatPriceTime(''), '');
});

test('CSV import can carry the original change date (Taiwan time); blank means now; bad dates are flagged', async () => {
  const importContext = { window: {}, document: { getElementById: () => null } };
  vm.runInNewContext(await read('item-import.js'), importContext);
  const X = importContext.window.ItemImport;
  assert.match(X.templateCsv(), /價格異動時間/);
  const csv = ['品項名稱,分類,車種,售價,價格異動時間', '座墊,外觀元件,,950,2021-07-23 16:32:26', '後架,機構元件,,1380,2026/11/3', '內箱,外觀元件,,2500,', '踏板,外觀元件,,600,2026-02-30', '側條,外觀元件,,650,昨天'].join('\n');
  const preview = X.buildPreview(I.emptyState(), csv, { inventory: I });
  assert.deepEqual(JSON.parse(JSON.stringify(preview.rows.map(row => row.errors.length))), [0, 0, 0, 1, 1]);
  assert.match(preview.rows[3].errors[0], /價格異動時間格式/);
  const ok = X.buildPreview(I.emptyState(), csv.split('\n').slice(0, 4).join('\n'), { inventory: I }).nextState.items;
  assert.equal(ok[0].priceChangedAt, '2021-07-23T08:32:26.000Z');
  assert.equal(ok[1].priceChangedAt, '2026-11-02T16:00:00.000Z');
  assert.ok(isNow(ok[2].priceChangedAt));
});

test('the time is loaded from the database, sent only for new items, and shown in the list and the edit form', async () => {
  const [cloud, html, app, migration] = await Promise.all(['cloud-data.js', 'index.html', 'app.js', 'supabase/migrations/20261110010000_price_changed_at.sql'].map(read));
  assert.match(cloud, /price_changed_at,stock,/);
  assert.match(cloud, /priceChangedAt: row\.price_changed_at \?\? ''/);
  assert.match(cloud, /upsert\(newItems\.map\(item => \(\{ \.\.\.itemRow\(item\), price_changed_at: item\.priceChangedAt \|\| null \}\)\)/);
  assert.doesNotMatch(cloud.match(/const itemRow = .*/)[0], /price_changed_at/, '更新品項時不送時間，由資料庫在價格有變時自己記');
  assert.match(html, /<p id="item-price-changed" class="hint price-tier-hint" hidden><\/p>/);
  assert.match(app, /stamp\.textContent = `改價 \$\{changed\}`/);
  assert.match(app, /最後價格異動：\$\{formatPriceTime\(item\.priceChangedAt, \{ time: true \}\) \|\| '尚無紀錄'\}/);
  assert.match(migration, /before insert or update on public\.items/);
  assert.match(migration, /after update on public\.item_costs/);
});
