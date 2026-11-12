// 自動序號：車身、電池入庫時，沒填原廠序號的件數自動編號＝分類 2 碼（車身 01、電池 02）＋入庫日期 8 碼＋流水號 4 碼。
// 三種入庫都會自動編：新增品項的初始庫存、庫存異動「進貨」、進貨單收貨。有填原廠序號的照填的；同分類同一天從 0001 往下編。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = { window: {}, crypto: globalThis.crypto };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const I = context.window.Inventory;
const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()).replaceAll('-', '');
const numbers = (state, itemId) => state.serials.filter(serial => serial.itemId === itemId).map(serial => serial.serialNumber);
const body = { name: '小偉士', category: '車身', price: 30000, cost: 0, minimumStock: 0 };

test('initial stock: entered serials are kept, the rest are numbered by category and date', () => {
  let state = I.addItem(I.emptyState(), { ...body, stock: 3, serialNumbers: ['VIN-001'] });
  assert.deepEqual([...numbers(state, state.items[0].id)], ['VIN-001', `01${DAY}0001`, `01${DAY}0002`]);
  state = I.addItem(state, { ...body, name: '大偉士', stock: 2 });
  assert.deepEqual([...numbers(state, state.items[1].id)], [`01${DAY}0003`, `01${DAY}0004`], '同分類同一天，不同品項也接著編');
  state = I.addItem(state, { name: '鋰電池', category: '電池', voltage: 48, capacity: 20, price: 1, cost: 0, minimumStock: 0, stock: 1 });
  assert.deepEqual([...numbers(state, state.items[2].id)], [`02${DAY}0001`], '電池是 02，另外從 0001 編');
  state = I.addItem(state, { name: '安全帽', category: '外觀元件', price: 1, cost: 0, minimumStock: 0, stock: 5 });
  assert.equal(numbers(state, state.items[3].id).length, 0, '零件不編序號');
});

test('stock-in ("進貨") numbers the units without a serial; stock counts (盤點) do not', () => {
  let state = I.addItem(I.emptyState(), { ...body, stock: 0 });
  const id = state.items[0].id;
  state = I.recordTransaction(state, { itemId: id, type: 'in', quantity: 2, serialNumbers: ['VIN-9'], createdBy: 'u' });
  assert.deepEqual([...numbers(state, id)], ['VIN-9', `01${DAY}0001`]);
  state = I.recordTransaction(state, { itemId: id, type: 'in', quantity: 1, createdBy: 'u' });
  assert.deepEqual([...numbers(state, id)], ['VIN-9', `01${DAY}0001`, `01${DAY}0002`]);
  state = I.recordTransaction(state, { itemId: id, type: 'adjust', quantity: 5, createdBy: 'u' });
  assert.equal(numbers(state, id).length, 3, '盤點調高庫存不自動編');
  // 已被用掉的號碼會跳過（例如有人手動輸入了相同格式的號碼）。
  state = I.recordTransaction(state, { itemId: id, type: 'in', quantity: 2, serialNumbers: [`01${DAY}0004`], createdBy: 'u' });
  assert.deepEqual([...numbers(state, id)].slice(-2), [`01${DAY}0004`, `01${DAY}0005`]);
});

test('receiving a purchase numbers the units without a serial', () => {
  let state = I.addSupplier(I.emptyState(), { name: '車廠' });
  state = I.addItem(state, { ...body, stock: 0, supplierId: state.suppliers[0].id });
  const id = state.items[0].id;
  state = I.createPurchase(state, { supplierId: state.suppliers[0].id, lines: [{ itemId: id, quantity: 3, unitCost: 20000 }] });
  state = I.receivePurchase(state, state.purchases[0].id, { receivedBy: 'u', serialNumbersByItem: { [id]: ['VIN-A'] } });
  assert.deepEqual([...numbers(state, id)], ['VIN-A', `01${DAY}0001`, `01${DAY}0002`]);
  assert.ok(state.serials.every(serial => serial.purchaseId === state.purchases[0].id), '自動序號也記在這張進貨單，雲端收貨時一起送出');
  assert.equal(state.items[0].stock, 3);
});

test('stock-in serials are sent with the stock-in quantity; backfilled serials are not', async () => {
  const [cloud, html] = await Promise.all(['cloud-data.js', 'index.html'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.match(cloud, /entry\.itemId === itemId && entry\.type === 'in' && !entry\.purchaseId/);
  assert.match(cloud, /p_serials: serials, \.\.\.\(stockIn \? \{ p_stock_in_quantity: stockIn \} : \{\}\)/);
  assert.match(html, /沒填的件數會自動編序號/);
});
