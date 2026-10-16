import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const context = { crypto: webcrypto, window: {} };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const I = context.window.Inventory;
const motor = { name: '機車', category: '機車', sku: 'MOTOR', barcode: 'motor', price: 1000, cost: 600, stock: 0, minimumStock: 0, warrantyMonths: 12 };
function legacy(stock = 2) {
  const state = I.addItem(I.emptyState(), motor);
  state.items[0].stock = stock;
  delete state.serials;
  return state;
}
test('legacy state loads without invented serials and registration preserves stock and strings', () => {
  const old = legacy();
  assert.equal(I.validateState(old).serials.length, 0);
  const next = I.registerSerials(old, { itemId: old.items[0].id, serialNumbers: [' 000123 ', '電池-A'], createdBy: 'manager' });
  assert.equal(next.items[0].stock, 2);
  assert.equal(next.transactions.length, 0);
  assert.deepEqual(Array.from(next.serials, s => s.serialNumber), ['000123', '電池-A']);
  assert.equal(next.serials[0].createdBy, 'manager');
  assert.equal(I.validateState(JSON.parse(I.toBackup(next))).serials.length, 2);
  assert.equal(I.validateState(legacy(1.5)).items[0].stock, 1.5);
  assert.throws(() => I.registerSerials(legacy(1.5), { itemId: old.items[0].id, serialNumbers: ['X'], createdBy: 'manager' }));
});
test('registration rejects duplicates invalid relations and exceeding unidentified stock', () => {
  let state = legacy(); const itemId = state.items[0].id;
  for (const serialNumbers of [[''], [123], ['X', ' X '], ['A', 'B', 'C']]) assert.throws(() => I.registerSerials(state, { itemId, serialNumbers, createdBy: 'm' }));
  state = I.registerSerials(state, { itemId, serialNumbers: ['X'], createdBy: 'm' });
  state = I.registerSerials(state, { itemId, serialNumbers: ['Y'], createdBy: 'm' });
  assert.throws(() => I.registerSerials(state, { itemId, serialNumbers: ['Z'], createdBy: 'm' }));
  for (const patch of [{ itemId: 'missing' }, { status: 'unknown' }, { serialNumber: '' }, { status: 'sold' }, { status: 'removed' }]) {
    const bad = structuredClone(state); Object.assign(bad.serials[0], patch);
    assert.throws(() => I.validateState(bad));
  }
  const duplicate = structuredClone(state); duplicate.serials[1].serialNumber = 'X';
  assert.throws(() => I.validateState(duplicate));
  const duplicateId = structuredClone(state); duplicateId.serials[1].id = duplicateId.serials[0].id;
  assert.throws(() => I.validateState(duplicateId));
});

test('initial serialized stock requires matching numbers and whole receipts are atomic', () => {
  assert.throws(() => I.addItem(I.emptyState(), { ...motor, stock: 2 }), /序號/);
  let state = I.addItem(I.emptyState(), { ...motor, stock: 2, serialNumbers: ['M1', 'M2'], createdBy: 'm' });
  assert.equal(state.serials.length, 2);
  state = I.addSupplier(state, { name: '供應商' });
  state = I.updateItem(state, state.items[0].id, { ...state.items[0], supplierId: state.suppliers[0].id });
  state = I.createPurchase(state, { supplierId: state.suppliers[0].id, lines: [{ itemId: state.items[0].id, quantity: 2, unitCost: 700 }] });
  const purchaseId = state.purchases[0].id, itemId = state.items[0].id;
  const before = JSON.stringify(state);
  for (const numbers of [[], ['M3'], ['M3', 'M1'], ['M3', 'M3']]) assert.throws(() => I.receivePurchase(state, purchaseId, { receivedBy: 'm', serialNumbersByItem: { [itemId]: numbers } }), /序號/);
  assert.equal(JSON.stringify(state), before);
  const next = I.receivePurchase(state, purchaseId, { receivedBy: 'm', serialNumbersByItem: { [itemId]: ['M3', 'M4'] } });
  assert.equal(next.items[0].stock, 4); assert.equal(next.items[0].cost, 700);
  assert.equal(next.serials[3].purchaseId, purchaseId);
  assert.throws(() => I.receivePurchase(next, purchaseId, { receivedBy: 'm' }));
});

test('serialized movements require physical units and editing cannot bypass tracking', () => {
  let state = I.addItem(I.emptyState(), { ...motor, stock: 2, serialNumbers: ['A', 'B'] });
  const itemId = state.items[0].id, serialId = state.serials[0].id;
  assert.throws(() => I.recordTransaction(state, { itemId, type: 'in', quantity: 1 }));
  assert.throws(() => I.recordTransaction(state, { itemId, type: 'out', quantity: 1, note: '報廢', createdBy: 'm' }));
  assert.throws(() => I.recordTransaction(state, { itemId, type: 'out', quantity: 1, serialIds: [serialId], createdBy: 'm' }));
  state = I.recordTransaction(state, { itemId, type: 'out', quantity: 1, serialIds: [serialId], note: '報廢', createdBy: 'm' });
  assert.equal(state.items[0].stock, 1); assert.equal(state.serials[0].status, 'removed');
  assert.equal(state.serials[0].removedBy, 'm');
  assert.throws(() => I.recordTransaction(state, { itemId, type: 'out', quantity: 1, serialIds: [serialId], note: '報廢', createdBy: 'm' }));
  state = I.recordTransaction(state, { itemId, type: 'adjust', quantity: 2, serialNumbers: ['C'], createdBy: 'm' });
  assert.equal(state.serials.length, 3);
  assert.throws(() => I.updateItem(state, itemId, { ...state.items[0], stock: 3 }));
  assert.throws(() => I.updateItem(state, itemId, { ...state.items[0], category: '用品' }));
  assert.throws(() => I.deleteItem(state, itemId));
  assert.throws(() => I.registerSerials({ ...state, items: [{ ...state.items[0], stock: 3 }] }, { itemId, serialNumbers: ['A'] }));
});
test('legacy unidentified and fractional stock can be reconciled without invented units', () => {
  let state = legacy(3); const itemId = state.items[0].id;
  state = I.registerSerials(state, { itemId, serialNumbers: ['A'], createdBy: 'm' });
  state = I.recordTransaction(state, { itemId, type: 'adjust', quantity: 1, note: '核對', createdBy: 'm' });
  assert.equal(state.items[0].stock, 1); assert.equal(state.serials.length, 1);
  assert.throws(() => I.recordTransaction(state, { itemId, type: 'adjust', quantity: 0, note: '核對', createdBy: 'm' }));
  const fractional = legacy(1.5);
  const corrected = I.recordTransaction(fractional, { itemId: fractional.items[0].id, type: 'adjust', quantity: 2, note: '核對', createdBy: 'm' });
  assert.equal(corrected.items[0].stock, 2); assert.equal(corrected.serials.length, 0);
});
function saleFixture(warrantyMonths = 0) {
  let state = I.addItem(I.emptyState(), { ...motor, warrantyMonths, stock: 3, serialNumbers: ['000A', 'B', 'C'] });
  state = I.addItem(state, { ...motor, category: '用品', sku: 'OTHER', barcode: 'other', stock: 2, warrantyMonths: 0 });
  state = I.addCustomer(state, { name: '客戶', phone: '0912345678' });
  return I.addSalesperson(state, { name: '測試業務' });
}
test('backup rejects contradictory sale identity dates and malformed warranty serial fields', () => {
  const state = saleFixture(12);
  const sold = I.recordSaleBatch(state, { customerId: state.customers[0].id, salespersonId: state.salespeople[0].id, lines: [{ itemId: state.items[0].id, quantity: 1, serialIds: [state.serials[0].id] }] });
  const mutations = [
    s => { s.sales[0].id = ''; s.serials[0].saleId = ''; s.warranties[0].saleId = ''; },
    s => s.sales.push({ ...s.sales[0], serialIds: [], serialNumbers: [] }),
    s => { s.serials[0].soldAt = '2000-01-01T00:00:00Z'; },
    ...['serialId', 'serialNumber'].flatMap(key => [123, null, {}, []].map(value => s => { s.warranties[0][key] = value; })),
    s => { s.warranties[0].serialId = 123; s.warranties[0].serialNumber = 456; },
  ];
  for (const mutate of mutations) { const bad = structuredClone(sold); mutate(bad); assert.throws(() => I.validateState(bad)); }
});
test('backup rejects more physical units than received purchase quantity', () => {
  let state = I.addItem(I.emptyState(), motor);
  state = I.addSupplier(state, { name: '供應商' });
  state = I.updateItem(state, state.items[0].id, { ...state.items[0], supplierId: state.suppliers[0].id });
  state = I.createPurchase(state, { supplierId: state.suppliers[0].id, lines: [{ itemId: state.items[0].id, quantity: 1, unitCost: 700 }] });
  state = I.receivePurchase(state, state.purchases[0].id, { receivedBy: 'm', serialNumbersByItem: { [state.items[0].id]: ['A'] } });
  state.serials.push({ ...state.serials[0], id: 'extra', serialNumber: 'B' }); state.items[0].stock = 2;
  assert.throws(() => I.validateState(state));
});
test('mixed checkout sells specified units and rejects stale duplicate missing serials atomically', () => {
  const state = saleFixture(), itemId = state.items[0].id, customerId = state.customers[0].id;
  const ids = state.serials.map(s => s.id), before = JSON.stringify(state);
  const lines = [{ itemId, quantity: 2, serialIds: ids.slice(0, 2) }, { barcode: 'other', quantity: 1 }];
  const next = I.recordSaleBatch(state, { lines, customerId, salespersonId: state.salespeople[0].id, createdBy: 'm' });
  assert.equal(next.items[0].stock, 1); assert.equal(next.items[1].stock, 1);
  assert.deepEqual(Array.from(next.serials, s => s.status), ['sold', 'sold', 'in_stock']);
  assert.deepEqual(Array.from(next.sales[0].serialNumbers), ['000A', 'B']);
  assert.equal(next.serials[0].saleId, next.sales[0].id); assert.equal(next.serials[0].customerId, customerId);
  assert.equal(next.warranties.length, 0);
  assert.equal(I.validateState(next).serials.length, 3);
  for (const invalid of [[], [ids[0]], [ids[0], ids[0]], ['missing', ids[0]]]) assert.throws(() => I.recordSaleBatch(state, { customerId, lines: [{ itemId, quantity: 2, serialIds: invalid }] }));
  assert.throws(() => I.recordSaleBatch(state, { lines }));
  assert.throws(() => I.recordSaleBatch(state, { customerId, lines: [{ itemId, quantity: 1, serialIds: [ids[0]] }, { itemId, quantity: 1, serialIds: [ids[0]] }] }));
  assert.throws(() => I.recordSaleBatch(next, { customerId, lines: [{ itemId, quantity: 1, serialIds: [ids[0]] }] }));
  assert.throws(() => I.recordSale(state, { barcode: 'motor', quantity: 1 }));
  assert.throws(() => I.recordSaleBatch(state, { customerId, lines: [{ barcode: 'other', quantity: 1, serialIds: [ids[0]] }] }));
  assert.equal(JSON.stringify(state), before);
  const pending = legacy();
  assert.throws(() => I.recordSaleBatch(pending, { customerId, lines: [{ itemId: pending.items[0].id, quantity: 1 }] }));
});
test('two physical serials create two warranties and malformed snapshots are rejected', () => {
  const state = saleFixture(12), customerId = state.customers[0].id;
  const next = I.recordSaleBatch(state, { customerId, salespersonId: state.salespeople[0].id, createdBy: 'staff', lines: [{ itemId: state.items[0].id, quantity: 2, serialIds: state.serials.slice(0, 2).map(s => s.id) }] });
  assert.equal(next.warranties.length, 2);
  assert.deepEqual(Array.from(next.warranties, w => w.serialNumber), ['000A', 'B']);
  assert.equal(I.warrantiesForFilter(next, { query: '000A' }).length, 1);
  assert.throws(() => I.createWarranty(next, { serialId: next.serials[0].id, itemId: next.items[0].id, customerId, purchasedAt: '2026-10-11', expiresAt: '2027-10-11' }));
  const bad = structuredClone(next); bad.warranties[0].serialNumber = 'wrong'; assert.throws(() => I.validateState(bad));
  const changed = I.updateWarranty(next, next.warranties[0].id, { serialId: 'wrong', serialNumber: 'wrong', saleId: 'wrong', note: '備註' });
  assert.equal(changed.warranties[0].serialId, next.serials[0].id);
});
test('manual serial warranty derives sold identity and refuses unsold units', () => {
  const state = saleFixture(), customerId = state.customers[0].id, itemId = state.items[0].id;
  const fields = { itemId, customerId, serialId: state.serials[0].id, purchasedAt: '2026-10-11', expiresAt: '2027-10-11' };
  assert.throws(() => I.createWarranty(state, fields));
  const sold = I.recordSaleBatch(state, { customerId, salespersonId: state.salespeople[0].id, lines: [{ itemId, quantity: 1, serialIds: [fields.serialId] }] });
  const next = I.createWarranty(sold, fields);
  assert.equal(next.warranties[0].serialNumber, '000A');
  assert.equal(next.warranties[0].saleId, sold.sales[0].id);
  assert.throws(() => I.createWarranty(sold, { ...fields, customerId: 'wrong' }));
  assert.throws(() => I.createWarranty(next, fields));
});

function warrantyIssueFixture() {
  const state = saleFixture(12);
  return I.recordSaleBatch(state, { customerId: state.customers[0].id, salespersonId: state.salespeople[0].id, lines: [{ itemId: state.items[0].id, quantity: 1, serialIds: [state.serials[0].id] }] });
}
test('warranty issue deducts specified units without sales or renewed warranties and preserves cost snapshot', () => {
  const state = warrantyIssueFixture(), warranty = state.warranties[0], serial = state.serials[1];
  const fields = { type: 'warranty_out', itemId: serial.itemId, quantity: 1, warrantyId: warranty.id, serialIds: [serial.id], createdBy: 'manager', createdByAccount: 'Johnny', note: '故障免費更換' };
  const next = I.recordTransaction(state, fields);
  assert.equal(state.items[0].stock, 2); assert.equal(next.items[0].stock, 1);
  assert.equal(next.serials[1].status, 'warranty_out'); assert.equal(next.serials[1].customerId, warranty.customerId);
  assert.equal(next.serials[1].warrantyId, warranty.id); assert.equal(next.serials[0].status, 'sold');
  assert.equal(next.sales.length, state.sales.length); assert.equal(next.warranties.length, 1);
  assert.equal(next.warranties[0].expiresAt, warranty.expiresAt);
  const tx = next.transactions.at(-1);
  assert.equal(tx.warrantyId, warranty.id); assert.equal(tx.customerId, warranty.customerId);
  assert.equal(tx.expiresAt, warranty.expiresAt); assert.equal(tx.unitCostSnapshot, 600);
  assert.equal(tx.createdBy, 'manager'); assert.deepEqual(Array.from(tx.serialNumbers), ['B']);
  assert.equal(tx.createdByAccount, 'Johnny');
  assert.equal(I.warrantiesForFilter(next, { query: 'B' }).length, 1);
  const edited = I.updateItem(next, serial.itemId, { ...next.items[0], cost: 999 });
  assert.equal(edited.transactions.at(-1).unitCostSnapshot, 600);
  assert.equal(I.validateState(JSON.parse(I.toBackup(edited))).serials[1].status, 'warranty_out');
  assert.throws(() => I.recordTransaction(next, fields));
  assert.throws(() => I.recordSaleBatch(next, { customerId: warranty.customerId, lines: [{ itemId: serial.itemId, quantity: 1, serialIds: [serial.id] }] }));
  assert.throws(() => I.deleteWarranty(next, warranty.id), /出保固/);
});
test('warranty issue rejects missing warranty reason actor invalid quantities and mismatched units atomically', () => {
  const state = warrantyIssueFixture(), before = JSON.stringify(state);
  const fields = { type: 'warranty_out', itemId: state.items[0].id, quantity: 1, warrantyId: state.warranties[0].id, serialIds: [state.serials[1].id], createdBy: 'manager', note: '更換' };
  for (const patch of [{ warrantyId: '' }, { warrantyId: 'missing' }, { note: '' }, { createdBy: '' }, { quantity: 0 }, { quantity: 0.5 }, { quantity: Number.MAX_SAFE_INTEGER + 1 }, { quantity: 3 }, { serialIds: [] }, { serialIds: [state.serials[0].id] }, { serialIds: [state.serials[1].id, state.serials[1].id] }, { serialNumbers: ['new'] }]) {
    assert.throws(() => I.recordTransaction(state, { ...fields, ...patch }));
  }
  const incomplete = structuredClone(state); incomplete.items[0].stock = 3;
  assert.throws(() => I.recordTransaction(incomplete, fields), /補齊/);
  assert.equal(JSON.stringify(state), before);
});
test('nonserialized warranty replacements support another product and keep legacy movements compatible', () => {
  const state = warrantyIssueFixture();
  const next = I.recordTransaction(state, { type: 'warranty_out', itemId: state.items[1].id, quantity: 2, warrantyId: state.warranties[0].id, note: '換配件', createdBy: 'manager' });
  assert.equal(next.items[1].stock, 0); assert.equal(next.serials[1].status, 'in_stock');
  assert.equal(next.transactions.at(-1).serialIds.length, 0);
  assert.equal(next.transactions.at(-1).unitCostSnapshot, 600);
  assert.equal(next.sales.length, 1);
  assert.throws(() => I.deleteItem(next, state.items[1].id), /出保固/);
  assert.throws(() => I.deleteCustomer(next, state.customers[0].id), /出保固/);
  assert.equal(I.recordTransaction(state, { type: 'out', itemId: state.items[1].id, quantity: 1 }).items[1].stock, 1);
});
test('backup rejects broken warranty replacement relations instead of dropping fields', () => {
  const state = warrantyIssueFixture();
  const next = I.recordTransaction(state, { type: 'warranty_out', itemId: state.items[0].id, quantity: 1, warrantyId: state.warranties[0].id, serialIds: [state.serials[1].id], note: '更換', createdBy: 'manager' });
  const mutations = [
    s => { s.transactions.at(-1).warrantyId = 'missing'; },
    s => { s.transactions.at(-1).customerId = 'missing'; },
    s => { s.transactions.at(-1).serialNumbers = ['wrong']; },
    s => { s.transactions.at(-1).serialIds = []; },
    s => { s.transactions.at(-1).unitCostSnapshot = -1; },
    s => { s.transactions.at(-1).expiresAt = 'invalid'; },
    s => { s.transactions.at(-1).createdBy = ''; },
    s => { s.transactions.at(-1).quantity = 0; },
    s => { s.serials[1].removedAt = '2000-01-01T00:00:00Z'; },
    s => { s.serials[1].warrantyId = ''; },
    s => { s.serials[1].status = 'removed'; s.serials[1].customerId = ''; s.serials[1].warrantyId = ''; },
    s => { s.transactions = []; },
    s => { s.warranties = []; },
  ];
  for (const mutate of mutations) { const bad = structuredClone(next); mutate(bad); assert.throws(() => I.validateState(bad)); }
});
test('battery replacement issues multiple physical serials under the same original warranty', () => {
  let state = warrantyIssueFixture();
  state = I.addItem(state, { category: '電池', name: '電池', sku: 'BATTERY', voltage: 72, capacity: 35, stock: 2, cost: 800, price: 1200, minimumStock: 0, warrantyMonths: 24, serialNumbers: ['000BAT1', '000BAT2'] });
  const battery = state.items.at(-1), serialIds = state.serials.filter(s => s.itemId === battery.id).map(s => s.id);
  const next = I.recordTransaction(state, { type: 'warranty_out', itemId: battery.id, warrantyId: state.warranties[0].id, quantity: 2, serialIds, note: '換電池', createdBy: 'manager' });
  assert.equal(next.items.at(-1).stock, 0);
  assert.equal(next.serials.filter(s => s.status === 'warranty_out').length, 2);
  assert.deepEqual(Array.from(next.transactions.at(-1).serialNumbers), ['000BAT1', '000BAT2']);
  assert.equal(next.transactions.at(-1).expiresAt, state.warranties[0].expiresAt);
  assert.equal(next.sales.length, 1); assert.equal(next.warranties.length, 1);
  assert.equal(I.warrantiesForFilter(next, { query: '000BAT2' })[0].id, state.warranties[0].id);
});
