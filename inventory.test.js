import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const context = { crypto: webcrypto, window: {} };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
const { addItem, addCustomer, addSalesperson, addWarrantyCase, createQuotation, createWarranty, deactivateCustomer, deactivateSalesperson, deleteCustomer, deleteItem, deleteWarranty, deleteWarrantyCase, code128Modules, emptyState, inventoryCost, recordSale, recordSaleBatch, recordTransaction, salesForMonth, toBackup, updateCustomer, updateItem, updateWarranty, updateWarrantyCase, validateState, warrantiesForFilter } = context.window.Inventory;

const item = {
  name: '前煞車皮',
  category: '零件',
  sku: 'BRK-001',
  barcode: '4710000000012',
  cost: 180,
  price: 350,
  stock: 2,
  minimumStock: 1,
  notes: '',
};

test('repair-used battery and repair-origin warranty remain valid without creating a sale', () => {
  let state = addItem(emptyState(), { ...item, name: '電池', category: '電池', stock: 0, voltage: 72, capacity: 35, warrantyMonths: 12 });
  state = addCustomer(state, { name: '會員甲', phone: '0900000001' });
  const at = '2026-10-16T05:00:00Z';
  const repairOrderId = 'repair-1';
  state.serials = [{ id: 'serial-1', itemId: state.items[0].id, serialNumber: 'BAT-001', status: 'repair_used', repairOrderId, repairLineId: 'line-1', customerId: state.customers[0].id, warrantyId: 'warranty-1', repairUsedAt: at, createdAt: at, createdBy: 'staff-1' }];
  state.transactions = [{ id: 'transaction-1', itemId: state.items[0].id, type: 'out', quantity: 1, note: '維修單 R-1', repairOrderId, serialIds: ['serial-1'], serialNumbers: ['BAT-001'], createdAt: at }];
  state.warranties = [{ id: 'warranty-1', customerId: state.customers[0].id, customerName: '會員甲', itemId: state.items[0].id, itemName: '電池', source: 'repair', repairOrderId, serialId: 'serial-1', serialNumber: 'BAT-001', purchasedAt: '2026-10-16', expiresAt: '2027-10-16', createdBy: 'staff-1', createdAt: at }];
  const normalized = validateState(state);
  assert.equal(normalized.serials[0].status, 'repair_used');
  assert.equal(normalized.warranties[0].source, 'repair');
  assert.equal(normalized.sales.length, 0);
  assert.throws(() => validateState({ ...state, warranties: [{ ...state.warranties[0], repairOrderId: 'wrong' }] }), /維修|保固/);
});

function withSalesperson(state) {
  return addSalesperson(state, { name: '陳業務' });
}

test('checkout requires an active salesperson and keeps the chosen ID on every line', () => {
  const noSalesperson = addItem(emptyState(), item);
  const lines = [{ itemId: noSalesperson.items[0].id, quantity: 1 }];
  assert.throws(() => recordSaleBatch(noSalesperson, { lines }), /業務/);
  assert.throws(() => recordSale(noSalesperson, { barcode: item.barcode, quantity: 1 }), /業務/);
  const ready = withSalesperson(noSalesperson);
  const salespersonId = ready.salespeople[0].id;
  assert.throws(() => recordSaleBatch(ready, { lines, salespersonId: 'missing' }), /業務/);
  const inactive = deactivateSalesperson(ready, salespersonId);
  assert.throws(() => recordSaleBatch(inactive, { lines, salespersonId }), /停用/);
  const sold = recordSaleBatch(ready, { lines: [lines[0], lines[0]], salespersonId });
  assert.deepEqual(Array.from(sold.sales, sale => sale.salespersonId), [salespersonId, salespersonId]);
});

test('checkout keeps one checkout id on every line so the cloud can de-duplicate retries', () => {
  const ready = withSalesperson(addItem(emptyState(), item));
  const lines = [{ itemId: ready.items[0].id, quantity: 1 }, { itemId: ready.items[0].id, quantity: 1 }];
  const salespersonId = ready.salespeople[0].id;
  const checkoutId = '11111111-1111-4111-8111-111111111111';
  const sold = recordSaleBatch(ready, { lines, salespersonId, checkoutId });
  assert.deepEqual(Array.from(sold.sales, sale => sale.checkoutId), [checkoutId, checkoutId]);
  const generated = recordSaleBatch(ready, { lines, salespersonId });
  assert.match(generated.sales[0].checkoutId, /^[0-9a-f-]{36}$/);
  assert.equal(generated.sales[1].checkoutId, generated.sales[0].checkoutId);
});

test('cart can select distinct products without barcodes and mix scanning', () => {
  let state = addItem(emptyState(), { ...item, barcode: '' });
  state = addItem(state, { ...item, sku: 'SECOND', name: '用品', barcode: '', price: 90 });
  state = withSalesperson(addItem(state, { ...item, sku: 'SCAN' }));
  const next = recordSaleBatch(state, { salespersonId: state.salespeople[0].id, lines: [{ itemId: state.items[0].id, quantity: 1 }, { itemId: state.items[1].id, quantity: 2 }, { barcode: item.barcode, quantity: 1 }] });
  assert.deepEqual(Array.from(next.items, product => product.stock), [1, 0, 1]);
  assert.deepEqual(Array.from(next.sales, sale => sale.unitPrice), [350, 90, 350]);
  assert.throws(() => recordSaleBatch(state, { lines: [{ itemId: 'deleted', barcode: item.barcode, quantity: 1 }] }), /找不到/);
  assert.throws(() => recordSaleBatch(state, { lines: [{ barcode: '', quantity: 1 }] }), /找不到/);
  assert.throws(() => recordSaleBatch(state, { lines: [{ itemId: state.items[2].id, quantity: 2 }, { barcode: item.barcode, quantity: 1 }] }), /庫存不足/);
  assert.equal(state.items[2].stock, 2);
});

test('customer association survives a sale without an automatic warranty', () => {
  let state = addItem(emptyState(), { ...item, warrantyMonths: 0 });
  state = addCustomer(state, { name: '王小明', phone: '0912' });
  state = withSalesperson(state);
  const sold = recordSaleBatch(state, { customerId: state.customers[0].id, salespersonId: state.salespeople[0].id, lines: [{ itemId: state.items[0].id, quantity: 1 }] });
  assert.equal(sold.sales[0].customerId, state.customers[0].id);
  assert.equal(sold.warranties.length, 0);
});

test('salespeople preserve optional login links and reject duplicate linked identities',()=>{
  const I=context.window.Inventory;
  let state=I.addSalesperson(I.emptyState(),{name:'業務一',authUserId:'staff-id'});
  assert.equal(state.salespeople[0].authUserId,'staff-id');
  assert.equal(I.validateState(JSON.parse(JSON.stringify(state))).salespeople[0].authUserId,'staff-id');
  assert.throws(()=>I.addSalesperson(state,{name:'業務二',authUserId:'staff-id'}),/連結/);
  state=I.updateSalesperson(state,state.salespeople[0].id,{name:'新姓名'});
  assert.equal(state.salespeople[0].authUserId,'staff-id');
  assert.equal(I.addSalesperson(I.emptyState(),{name:'舊業務'}).salespeople[0].authUserId,'');
});

test('manages suppliers and validates legacy state and supplier IDs', () => {
  const I = context.window.Inventory;
  const state = I.addSupplier(emptyState(), { name: ' 電池供應商 ', taxId: '12345678', phone: '02-1234' });
  const supplier = state.suppliers[0];
  assert.equal(supplier.name, '電池供應商');
  assert.equal(supplier.active, true);
  const edited = I.updateSupplier(state, supplier.id, { ...supplier, name: '新名稱', id: 'fake' });
  assert.equal(edited.suppliers[0].id, supplier.id);
  assert.equal(edited.suppliers[0].createdAt, supplier.createdAt);
  assert.equal(edited.suppliers[0].name, '新名稱');
  assert.equal(I.deactivateSupplier(edited, supplier.id).suppliers[0].active, false);
  assert.throws(() => I.addSupplier(state, { name: ' ' }), /名稱/);
  assert.throws(() => I.addSupplier(state, { name: '供應商', taxId: '123' }), /統編/);
  assert.throws(() => validateState({ ...state, suppliers: [supplier, supplier] }), /重複/);
  for (const value of [null, {}, 'bad']) {
    assert.throws(() => validateState({ items: [], transactions: [], suppliers: value }));
    assert.throws(() => validateState({ items: [], transactions: [], purchases: value }));
  }
  assert.equal(validateState({ items: [], transactions: [] }).suppliers.length, 0);
});

test('items have one optional supplier and cannot be newly assigned inactive suppliers', () => {
  const I = context.window.Inventory;
  const state = I.addSupplier(emptyState(), { name: '供應商' });
  const supplierId = state.suppliers[0].id;
  const stocked = addItem(state, { ...item, supplierId });
  assert.equal(stocked.items[0].supplierId, supplierId);
  const inactive = I.deactivateSupplier(stocked, supplierId);
  assert.equal(updateItem(inactive, stocked.items[0].id, stocked.items[0]).items[0].supplierId, supplierId);
  assert.throws(() => addItem(inactive, { ...item, supplierId, barcode: 'different' }), /停用/);
  assert.throws(() => addItem(state, { ...item, supplierId: 'missing' }), /供應商/);
  assert.equal(updateItem(inactive, stocked.items[0].id, { ...stocked.items[0], supplierId: '' }).items[0].supplierId, '');
  assert.equal(addItem(emptyState(), item).items[0].supplierId, '');
});

function purchaseFixture() {
  const I = context.window.Inventory;
  let state = I.addSupplier(emptyState(), { name: '供應商', contact: '王先生', taxId: '12345678' });
  const supplierId = state.suppliers[0].id;
  state = addItem(state, { ...item, supplierId });
  state = addItem(state, { ...item, name: '另一品項', sku: 'OTHER', barcode: '1234567890123', supplierId });
  return { state, fields: { supplierId, createdBy: 'admin-user', note: '測試進貨', lines: [{ itemId: state.items[0].id, quantity: 3, unitCost: 0.1 }, { itemId: state.items[1].id, quantity: 2, unitCost: 1.25 }] } };
}

test('purchase drafts calculate cents, preserve stock and snapshot supplier and products', () => {
  const I = context.window.Inventory;
  const { state, fields } = purchaseFixture();
  const draft = I.createPurchase(state, fields);
  const purchase = draft.purchases[0];
  assert.equal(purchase.total, 2.8);
  assert.equal(purchase.lines[0].subtotal, 0.3);
  assert.equal(purchase.status, 'draft');
  assert.equal(purchase.paymentStatus, 'unpaid');
  assert.equal(purchase.createdBy, 'admin-user');
  assert.equal(purchase.receivedAt, '');
  assert.match(purchase.number, /^P\d{8}001$/);
  assert.equal(JSON.stringify(draft.items), JSON.stringify(state.items));
  assert.equal(draft.transactions.length, 0);
  const renamed = I.updateSupplier(draft, fields.supplierId, { name: '改名' });
  assert.equal(renamed.purchases[0].supplierSnapshot.name, '供應商');
  const updated = I.updatePurchase(renamed, purchase.id, { ...fields, createdBy: 'fake', status: 'received' });
  assert.equal(updated.purchases[0].supplierSnapshot.name, '改名');
  assert.equal(updated.purchases[0].createdBy, 'admin-user');
  assert.equal(updated.purchases[0].status, 'draft');
  assert.equal(I.createPurchase(draft, fields).purchases[1].number.slice(-3), '002');
  const atLimit = validateState({ ...draft, purchases: [{ ...purchase, number: purchase.number.slice(0, -3) + '999' }] });
  assert.throws(() => I.createPurchase(atLimit, fields), /999/);
  assert.equal(I.deletePurchase(draft, purchase.id).purchases.length, 0);
  const inactive = I.deactivateSupplier(draft, fields.supplierId);
  assert.throws(() => I.createPurchase(inactive, fields), /停用/);
  assert.equal(I.updatePurchase(inactive, purchase.id, fields).purchases.length, 1);
});

test('purchase drafts reject invalid lines, money, totals and associations', () => {
  const I = context.window.Inventory;
  const { state, fields } = purchaseFixture();
  assert.throws(() => I.createPurchase(state, { ...fields, lines: [] }));
  assert.throws(() => I.createPurchase(state, { ...fields, lines: [fields.lines[0], fields.lines[0]] }), /重複/);
  for (const unitCost of [-1, 0.001, Infinity, Number.MAX_SAFE_INTEGER, '', null, true]) {
    assert.throws(() => I.createPurchase(state, { ...fields, lines: [{ ...fields.lines[0], unitCost }] }));
  }
  for (const quantity of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => I.createPurchase(state, { ...fields, lines: [{ ...fields.lines[0], quantity }] }));
  }
  const draft = I.createPurchase(state, fields);
  for (const changes of [{ total: 2.81 }, { number: 'bad' }, { status: 'bad' }, { paymentStatus: 'paid' }, { paidAt: new Date().toISOString() }]) {
    assert.throws(() => validateState({ ...draft, purchases: [{ ...draft.purchases[0], ...changes }] }));
  }
  assert.throws(() => validateState({ ...draft, purchases: [draft.purchases[0], draft.purchases[0]] }), /重複/);
  const unassigned = updateItem(draft, state.items[0].id, { ...state.items[0], supplierId: '' });
  assert.throws(() => I.updatePurchase(unassigned, draft.purchases[0].id, fields), /供應商/);
  const zero = I.createPurchase(state, { ...fields, lines: [{ ...fields.lines[0], unitCost: 0 }] });
  assert.equal(zero.purchases[0].total, 0);
});

test('purchase money refuses safe cents that lose precision in stored numeric amounts', () => {
  const I = context.window.Inventory;
  const { state, fields } = purchaseFixture();
  assert.throws(() => I.createPurchase(state, { ...fields, lines: [{ ...fields.lines[0], quantity: 1, unitCost: '90071992547409.91' }] }), /安全|精度/);
  const draft = I.createPurchase(state, { ...fields, lines: [{ ...fields.lines[0], quantity: 1, unitCost: '999999.99' }] });
  assert.equal(draft.purchases[0].total, 999999.99);
});

test('receives all purchase lines once and marks payment without changing historical sales', () => {
  const I = context.window.Inventory;
  const { state, fields } = purchaseFixture();
  const saleReady = withSalesperson(state);
  const sold = recordSale(saleReady, { barcode: state.items[0].barcode, quantity: 1, salespersonId: saleReady.salespeople[0].id });
  const draft = I.createPurchase(sold, fields);
  const pid = draft.purchases[0].id;
  assert.throws(() => I.markPurchasePaid(draft, pid, { paidBy: 'admin' }), /收貨/);
  assert.throws(() => deleteItem(draft, state.items[0].id), /進貨/);
  const received = I.receivePurchase(I.deactivateSupplier(draft, fields.supplierId), pid, { receivedBy: 'receiver' });
  assert.equal(received.items[0].stock, 4);
  assert.equal(received.items[1].stock, 4);
  assert.equal(received.items[0].cost, 0.1);
  assert.equal(received.items[1].cost, 1.25);
  assert.equal(received.items[0].price, state.items[0].price);
  assert.equal(received.items[0].sku, state.items[0].sku);
  assert.equal(received.items[0].barcode, state.items[0].barcode);
  assert.equal(JSON.stringify(received.sales), JSON.stringify(sold.sales));
  const receiptTransactions = received.transactions.filter((tx) => tx.purchaseId === pid);
  assert.equal(receiptTransactions.length, 2);
  assert.equal(receiptTransactions[0].type, 'in');
  assert.equal(receiptTransactions[0].quantity, 3);
  assert.match(receiptTransactions[0].note, /P\d{11}/);
  assert.equal(received.purchases[0].receivedBy, 'receiver');
  assert.ok(received.purchases[0].receivedAt);
  assert.throws(() => I.receivePurchase(received, pid, { receivedBy: 'again' }), /收貨/);
  assert.throws(() => I.updatePurchase(received, pid, fields), /收貨/);
  assert.throws(() => I.deletePurchase(received, pid), /收貨/);
  assert.throws(() => deleteItem(received, state.items[0].id), /進貨/);
  const paid = I.markPurchasePaid(received, pid, { paidBy: 'payer' });
  assert.equal(paid.purchases[0].paymentStatus, 'paid');
  assert.equal(paid.purchases[0].paidBy, 'payer');
  assert.ok(paid.purchases[0].paidAt);
  assert.equal(JSON.stringify(paid.items), JSON.stringify(received.items));
  assert.equal(JSON.stringify(paid.transactions), JSON.stringify(received.transactions));
  assert.throws(() => I.markPurchasePaid(paid, pid, { paidBy: 'again' }), /付款/);
  assert.equal(JSON.stringify(validateState(JSON.parse(toBackup(paid)))), JSON.stringify(paid));
});

test('receipt rejects stale supplier assignments, unsafe stock and invalid transaction references atomically', () => {
  const I = context.window.Inventory;
  const { state, fields } = purchaseFixture();
  const draft = I.createPurchase(state, fields);
  const pid = draft.purchases[0].id;
  const reassigned = updateItem(draft, state.items[1].id, { ...state.items[1], supplierId: '' });
  const before = JSON.stringify(reassigned);
  assert.throws(() => I.receivePurchase(reassigned, pid, { receivedBy: 'admin' }), /供應商/);
  assert.equal(JSON.stringify(reassigned), before);
  const huge = updateItem(draft, state.items[1].id, { ...state.items[1], stock: Number.MAX_SAFE_INTEGER });
  assert.throws(() => I.receivePurchase(huge, pid, { receivedBy: 'admin' }), /安全/);
  const received = I.receivePurchase(draft, pid, { receivedBy: 'admin' });
  const tx = received.transactions[0];
  assert.throws(() => validateState({ ...received, transactions: [{ ...tx, purchaseId: 'missing' }] }), /進貨/);
  assert.throws(() => validateState({ ...draft, transactions: [{ ...tx, purchaseId: pid }] }), /進貨/);
  assert.throws(() => validateState({ ...received, transactions: [{ ...tx, type: 'out' }] }), /進貨/);
  assert.throws(() => validateState({ ...draft, items: draft.items.slice(0, 1) }), /品項/);
});

test('adds a valid item without mutating the source state', () => {
  const state = emptyState();
  const next = addItem(state, item);

  assert.equal(state.items.length, 0);
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].name, '前煞車皮');
});

test('accepts 電池 as an item category', () => {
  const next = addItem(emptyState(), { ...item, category: '電池', voltage: 12, capacity: 7, serialNumbers: ['B1', 'B2'] });

  assert.equal(next.items[0].category, '電池');
});

test('battery names include current specifications once without renaming stored history', () => {
  const state = addItem(emptyState(), { ...item, name: '鋰電池', category: '電池', voltage: 72, capacity: 35, serialNumbers: ['B1', 'B2'] });
  const battery = state.items[0];
  assert.equal(battery.name, '鋰電池 72V 35Ah');
  const saved = updateItem(state, battery.id, battery);
  assert.equal(saved.items[0].name, '鋰電池 72V 35Ah');
  const edited = updateItem(saved, battery.id, { ...battery, capacity: 40 });
  assert.equal(edited.items[0].name, '鋰電池 72V 40Ah');
  assert.equal(state.items[0].name, '鋰電池 72V 35Ah');
  const supplied = addItem(emptyState(), { ...item, name: '鋰電池 72v35ah', category: '電池', voltage: 72, capacity: 35, serialNumbers: ['B1', 'B2'] });
  assert.equal(supplied.items[0].name, '鋰電池 72V 35Ah');
  assert.equal(addItem(emptyState(), item).items[0].name, item.name);
  assert.equal(validateState({ ...state, items: [{ ...battery, name: '原始電池名稱' }] }).items[0].name, '原始電池名稱');
});

test('generates category-date-sequence SKUs and preserves existing SKUs on edit', () => {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()).replaceAll('-', '');
  let state = emptyState();
  for (const [category, prefix] of [['機車', '11'], ['零件', '22'], ['用品', '33'], ['電池', '88']]) {
    state = addItem(state, { ...item, category, stock: 0, sku: '', barcode: '', voltage: 12, capacity: 7 });
    assert.equal(state.items.at(-1).sku, category === '電池' ? `88${date.slice(0, 4)}1207001` : `${prefix}${date}001`);
  }
  state = addItem(state, { ...item, stock: 0, sku: '', barcode: '' });
  assert.equal(state.items.at(-1).sku, `22${date}002`);
  const existing = state.items.at(-1);
  const edited = updateItem(state, existing.id, { ...existing, category: '電池', sku: 'changed', voltage: 12, capacity: 7 });
  assert.equal(edited.items.at(-1).sku, existing.sku);
  const full = addItem(emptyState(), { ...item, sku: `22${date}999` });
  assert.throws(() => addItem(full, { ...item, sku: '', barcode: '' }), /999/);
});

test('requires positive battery specifications and preserves them in backups and edits', () => {
  const battery = { ...item, category: '電池', voltage: 12, capacity: 7, serialNumbers: ['B1', 'B2'] };
  for (const fields of [{ voltage: '' }, { capacity: 0 }, { voltage: -1 }, { capacity: 'abc' }, { voltage: 100 }, { capacity: 100 }, { capacity: 7.5 }]) {
    assert.throws(() => addItem(emptyState(), { ...battery, ...fields }), /電壓|容量/);
  }
  const state = addItem(emptyState(), battery);
  const restored = validateState(JSON.parse(toBackup(state)));
  assert.equal(restored.items[0].voltage, 12);
  assert.equal(restored.items[0].capacity, 7);
  const edited = updateItem(state, state.items[0].id, { ...state.items[0], capacity: 9 });
  assert.equal(edited.items[0].capacity, 9);
  const legacy = validateState({ items: [{ ...battery, id: 'old', voltage: undefined, capacity: undefined }], transactions: [] });
  assert.equal(legacy.items[0].voltage, null);
  assert.throws(() => updateItem(legacy, 'old', legacy.items[0]), /電壓|容量/);
});

test('battery SKUs use year voltage capacity and a sequence per specification', () => {
  const year = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()).slice(0, 4);
  const battery = { ...item, stock: 0, category: '電池', sku: '', barcode: '', voltage: 72, capacity: 35 };
  const first = addItem(emptyState(), battery);
  assert.equal(first.items[0].sku, `88${year}7235001`);
  assert.equal(first.items[0].barcode, first.items[0].sku);
  const second = addItem(first, battery);
  assert.equal(second.items[1].sku, `88${year}7235002`);
  const other = addItem(second, { ...battery, capacity: 9 });
  assert.equal(other.items[2].sku, `88${year}7209001`);
  const edited = updateItem(first, first.items[0].id, { ...first.items[0], capacity: 40 });
  assert.equal(edited.items[0].sku, first.items[0].sku);
});

test('calculates inventory cost from each item cost and stock', () => {
  const withFirstItem = addItem(emptyState(), item);
  const withTwoItems = addItem(withFirstItem, { ...item, name: '機油', barcode: '4710000000029', cost: 120, stock: 3 });

  assert.equal(inventoryCost(withTwoItems), 720);
});

test('rejects a whitespace-only item name', () => {
  assert.throws(() => addItem(emptyState(), { ...item, name: '   ' }), /名稱/);
});

test('rejects an invalid category and negative stock', () => {
  assert.throws(() => addItem(emptyState(), { ...item, category: '輪胎' }), /分類/);
  assert.throws(() => addItem(emptyState(), { ...item, stock: -1 }), /庫存/);
});

test('records stock in, out, and adjustment transactions', () => {
  const state = addItem(emptyState(), item);
  const itemId = state.items[0].id;
  const stocked = recordTransaction(state, { itemId, type: 'in', quantity: 3, note: '到貨' });
  const sold = recordTransaction(stocked, { itemId, type: 'out', quantity: 1, note: '售出' });
  const adjusted = recordTransaction(sold, { itemId, type: 'adjust', quantity: 9, note: '盤點' });

  assert.equal(stocked.items[0].stock, 5);
  assert.equal(sold.items[0].stock, 4);
  assert.equal(adjusted.items[0].stock, 9);
  assert.equal(adjusted.transactions.length, 3);
});

test('rejects a sale that would exceed stock without changing state', () => {
  const state = addItem(emptyState(), item);
  const itemId = state.items[0].id;

  assert.throws(() => recordTransaction(state, { itemId, type: 'out', quantity: 3, note: '' }), /庫存不足/);
  assert.equal(state.items[0].stock, 2);
  assert.equal(state.transactions.length, 0);
});

test('deletes an item and its transactions', () => {
  const state = addItem(emptyState(), item);
  const itemId = state.items[0].id;
  const withTransaction = recordTransaction(state, { itemId, type: 'in', quantity: 1, note: '' });
  const next = deleteItem(withTransaction, itemId);

  assert.deepEqual(next, emptyState());
});

test('rejects malformed backup data', () => {
  assert.throws(() => validateState({ items: [{}], transactions: [] }), /品項/);
});

test('preserves a barcode and rejects duplicate barcodes', () => {
  const state = addItem(emptyState(), item);

  assert.equal(state.items[0].barcode, '4710000000012');
  assert.throws(() => addItem(state, { ...item, name: '後煞車皮' }), /條碼重複/);
});

test('accepts older items without a barcode', () => {
  const state = addItem(emptyState(), { ...item, barcode: undefined });

  assert.equal(state.items[0].barcode, '');
});

test('encodes thirteen digits with Code 128 checksum and quiet zones', () => {
  const modules = context.window.Inventory.code128Modules('8820267235001');

  assert.equal(modules.length, 143);
  assert.equal(modules.slice(0, 21), '000000000011010011100');
  // Symbols: start C, 88,20,26,72,35,00, switch B,17; checksum = 65.
  assert.equal(modules.slice(-34), '1001011000011000111010110000000000');
  for (const invalid of ['123', '882026723500A', '88202672350011']) {
    assert.throws(() => context.window.Inventory.code128Modules(invalid), /13 碼/);
  }
});

test('adds customers and rejects blank customer details', () => {
  assert.throws(() => addCustomer(emptyState(), { name: ' ', phone: '0912' }), /客戶姓名/);
  assert.throws(() => addCustomer(emptyState(), { name: '王小明', phone: ' ' }), /客戶電話/);

  const next = addCustomer(emptyState(), { name: '王小明', phone: '0912-345-678', note: '熟客' });
  assert.equal(next.customers[0].name, '王小明');
  assert.equal(next.customers[0].active, true);
});

test('assigns membership numbers, preserves addresses, and protects quoted customers', () => {
  const first = addCustomer(emptyState(), { name: '王小明', phone: '0912-345-678', address: '台北市中山區', note: '' });
  const second = addCustomer(first, { name: '李小美', phone: '0911-222-333', address: '', note: '' });
  assert.equal(first.customers[0].memberNumber, 'M000001');
  assert.equal(first.customers[0].address, '台北市中山區');
  assert.equal(second.customers[1].memberNumber, 'M000002');
  assert.equal(deleteCustomer(second, second.customers[1].id).customers.length, 1);

  const stocked = addItem(first, item);
  const ready = withSalesperson(stocked);
  const quoted = createQuotation(ready, { customerId: ready.customers[0].id, salespersonId: ready.salespeople[0].id, lines: [{ itemId: ready.items[0].id, quantity: 1 }] });
  assert.throws(() => deleteCustomer(quoted, quoted.customers[0].id), /報價/);
});

test('normalizes legacy customers without address or membership numbers', () => {
  const timestamp = '2026-10-09T00:00:00.000Z';
  const state = validateState({ items: [], transactions: [], customers: [{ id: 'legacy', name: '舊客戶', phone: '0900', note: '', active: true, createdAt: timestamp, updatedAt: timestamp }] });
  assert.equal(state.customers[0].memberNumber, 'M000001');
  assert.equal(state.customers[0].address, '');
  assert.deepEqual(Array.from(state.customers[0].plateNumbers), []);
});

test('stores optional multiple customer plates through edits', () => {
  const added = addCustomer(emptyState(), { name: '王小明', phone: '0912', plateNumbers: [' ABC-1234 ', 'DEF-5678'] });
  assert.deepEqual(Array.from(added.customers[0].plateNumbers), ['ABC-1234', 'DEF-5678']);
  const edited = updateCustomer(added, added.customers[0].id, { name: '王小明', phone: '0912', plateNumbers: ['DEF-5678'] });
  assert.deepEqual(Array.from(edited.customers[0].plateNumbers), ['DEF-5678']);
});

test('stores a salesperson snapshot on quotations and rejects inactive salespeople', () => {
  const stocked = addItem(emptyState(), item);
  const withCustomer = addCustomer(stocked, { name: '王小明', phone: '0912-345-678', note: '' });
  const withSalesperson = addSalesperson(withCustomer, { name: '陳業務' });
  const next = createQuotation(withSalesperson, {
    customerId: withSalesperson.customers[0].id,
    salespersonId: withSalesperson.salespeople[0].id,
    lines: [{ itemId: withSalesperson.items[0].id, quantity: 1 }],
  });

  assert.equal(next.quotations[0].salespersonName, '陳業務');
  const inactive = deactivateSalesperson(next, next.salespeople[0].id);
  assert.throws(() => createQuotation(inactive, { customerId: inactive.customers[0].id, salespersonId: inactive.salespeople[0].id, lines: [{ itemId: inactive.items[0].id, quantity: 1 }] }), /業務/);
});

test('creates price snapshots without changing inventory', () => {
  const stocked = addItem(emptyState(), item);
  const withCustomer = addCustomer(stocked, { name: '王小明', phone: '0912-345-678', note: '' });
  const ready = withSalesperson(withCustomer);
  const next = createQuotation(ready, {
    customerId: ready.customers[0].id,
    salespersonId: ready.salespeople[0].id,
    lines: [{ itemId: ready.items[0].id, quantity: 3 }],
    note: '含安裝',
  });

  assert.equal(next.items[0].stock, 2);
  assert.equal(next.transactions.length, 0);
  assert.equal(next.quotations[0].customerName, '王小明');
  assert.equal(next.quotations[0].lines[0].unitPrice, 350);
  assert.equal(next.quotations[0].lines[0].subtotal, 1050);
  assert.equal(next.quotations[0].total, 1050);
});

test('installation labor snapshots the shop hourly rate without changing material or old quotes', () => {
  const stocked = addItem(emptyState(), item);
  const ready = withSalesperson(addCustomer(stocked, { name: '王小明', phone: '0912-345-678' }));
  const base = { customerId: ready.customers[0].id, salespersonId: ready.salespeople[0].id };
  const old = createQuotation(ready, { ...base, lines: [{ itemId: ready.items[0].id, quantity: 1 }] });
  const quoted = createQuotation(old, { ...base, hourlyRate: 800, lines: [{ itemId: ready.items[0].id, quantity: 2, installationRequired: true, laborHours: 1.5 }] });
  assert.equal(quoted.quotations[0].total, 350);
  assert.equal(quoted.quotations[1].lines[0].subtotal, 700);
  assert.equal(quoted.quotations[1].lines[0].hourlyRate, 800);
  assert.equal(quoted.quotations[1].lines[0].laborAmount, 1200);
  assert.equal(quoted.quotations[1].total, 1900);
  assert.equal(quoted.quotations[0].lines[0].installationRequired, false);
  assert.equal(quoted.quotations[0].lines[0].laborAmount, 0);
  assert.equal(JSON.parse(toBackup(quoted)).quotations[1].lines[0].laborHours, 1.5);
  const fractional = createQuotation(ready, { ...base, hourlyRate: 0.29, lines: [{ itemId: ready.items[0].id, quantity: 1, installationRequired: true, laborHours: 0.5 }] });
  assert.equal(fractional.quotations[0].lines[0].laborAmount, 0.15);
});

test('installation requires valid hours and a configured positive hourly rate', () => {
  const stocked = addItem(emptyState(), item);
  const ready = withSalesperson(addCustomer(stocked, { name: '王小明', phone: '0912-345-678' }));
  const base = { customerId: ready.customers[0].id, salespersonId: ready.salespeople[0].id };
  for (const laborHours of [0, -1, 0.001, Infinity, '']) {
    assert.throws(() => createQuotation(ready, { ...base, hourlyRate: 800, lines: [{ itemId: ready.items[0].id, quantity: 1, installationRequired: true, laborHours }] }), /工時/);
  }
  assert.throws(() => createQuotation(ready, { ...base, hourlyRate: 0, lines: [{ itemId: ready.items[0].id, quantity: 1, installationRequired: true, laborHours: 1 }] }), /費率/);
});

test('rejects inactive customers and invalid quotation lines', () => {
  const stocked = addItem(emptyState(), item);
  const withCustomer = withSalesperson(addCustomer(stocked, { name: '王小明', phone: '0912-345-678', note: '' }));
  const inactive = deactivateCustomer(withCustomer, withCustomer.customers[0].id);

  assert.throws(() => createQuotation(inactive, { customerId: inactive.customers[0].id, salespersonId: inactive.salespeople[0].id, lines: [{ itemId: inactive.items[0].id, quantity: 1 }] }), /停用/);
  assert.throws(() => createQuotation(withCustomer, { customerId: withCustomer.customers[0].id, salespersonId: withCustomer.salespeople[0].id, lines: [] }), /至少/);
  assert.throws(() => createQuotation(withCustomer, { customerId: withCustomer.customers[0].id, salespersonId: withCustomer.salespeople[0].id, lines: [{ itemId: withCustomer.items[0].id, quantity: 0 }] }), /數量/);
});

test('keeps quotation snapshots and protects referenced items', () => {
  const stocked = addItem(emptyState(), item);
  const withCustomer = withSalesperson(addCustomer(stocked, { name: '王小明', phone: '0912-345-678', note: '' }));
  const quoted = createQuotation(withCustomer, { customerId: withCustomer.customers[0].id, salespersonId: withCustomer.salespeople[0].id, lines: [{ itemId: withCustomer.items[0].id, quantity: 1 }] });
  const changedItem = { ...quoted.items[0], price: 999 };
  const renamed = updateCustomer(quoted, quoted.customers[0].id, { name: '王大明', phone: '0988-000-000', note: '' });
  const changed = validateState({ ...renamed, items: [changedItem] });

  assert.equal(changed.quotations[0].customerName, '王小明');
  assert.equal(changed.quotations[0].customerPhone, '0912-345-678');
  assert.equal(changed.quotations[0].lines[0].unitPrice, 350);
  assert.throws(() => deleteItem(changed, changed.items[0].id), /報價/);
});

test('accepts old backups and round-trips quotation backups', () => {
  const old = validateState({ items: [], transactions: [] });
  assert.equal(old.customers.length, 0);
  assert.equal(old.quotations.length, 0);

  const stocked = addItem(emptyState(), item);
  const withCustomer = withSalesperson(addCustomer(stocked, { name: '王小明', phone: '0912-345-678', note: '' }));
  const quoted = createQuotation(withCustomer, { customerId: withCustomer.customers[0].id, salespersonId: withCustomer.salespeople[0].id, lines: [{ itemId: withCustomer.items[0].id, quantity: 1 }] });
  assert.equal(JSON.stringify(validateState(JSON.parse(toBackup(quoted)))), JSON.stringify(quoted));
});

test('uses the largest existing daily quotation sequence', () => {
  const stocked = addItem(emptyState(), item);
  const withCustomer = withSalesperson(addCustomer(stocked, { name: '王小明', phone: '0912-345-678', note: '' }));
  const first = createQuotation(withCustomer, { customerId: withCustomer.customers[0].id, salespersonId: withCustomer.salespeople[0].id, lines: [{ itemId: withCustomer.items[0].id, quantity: 1 }] });
  const datePrefix = first.quotations[0].number.slice(0, 8);
  const imported = validateState({ ...first, quotations: [{ ...first.quotations[0], number: `${datePrefix}-002` }] });
  const next = createQuotation(imported, { customerId: imported.customers[0].id, salespersonId: imported.salespeople[0].id, lines: [{ itemId: imported.items[0].id, quantity: 1 }] });

  assert.equal(next.quotations[1].number, `${datePrefix}-003`);
});

test('records a barcode sale with a price snapshot and deducts stock', () => {
  const stocked = withSalesperson(addItem(emptyState(), item));
  const sold = recordSale(stocked, { barcode: '4710000000012', quantity: 2, salespersonId: stocked.salespeople[0].id });

  assert.equal(sold.items[0].stock, 0);
  assert.equal(sold.transactions.at(-1).type, 'out');
  assert.equal(sold.sales[0].unitPrice, 350);
  assert.equal(sold.sales[0].subtotal, 700);
  assert.equal(sold.sales[0].itemName, '前煞車皮');
});

test('groups sales records by their saved month', () => {
  const stocked = withSalesperson(addItem(emptyState(), item));
  const sold = recordSale(stocked, { barcode: '4710000000012', quantity: 1, salespersonId: stocked.salespeople[0].id });
  const month = sold.sales[0].createdAt.slice(0, 7);

  assert.equal(salesForMonth(sold, month).length, 1);
  assert.equal(salesForMonth(sold, '2000-01').length, 0);
});

test('monthly sales use Taipei boundaries rather than UTC date prefixes', () => {
  let state = withSalesperson(addItem(emptyState(), { ...item, stock: 10 }));
  for (let index = 0; index < 4; index++) state = recordSale(state, { barcode: item.barcode, quantity: 1, salespersonId: state.salespeople[0].id });
  const times = ['2026-09-30T15:59:59Z', '2026-09-30T16:00:00Z', '2026-10-31T15:59:59Z', '2026-10-31T16:00:00Z'];
  state = { ...state, sales: state.sales.map((sale, index) => ({ ...sale, createdAt: times[index], quantity: index + 1 })) };
  assert.deepEqual(Array.from(salesForMonth(state, '2026-10'), sale => sale.quantity), [2, 3]);
});

test('checks out multiple products under one sale number', () => {
  const first = addItem(emptyState(), item);
  const stocked = withSalesperson(addItem(first, { ...item, name: '機油', barcode: '4710000000029', stock: 3, price: 120 }));
  const sold = recordSaleBatch(stocked, { salespersonId: stocked.salespeople[0].id, lines: [{ barcode: '4710000000012', quantity: 1 }, { barcode: '4710000000029', quantity: 2 }] });

  assert.equal(sold.items[0].stock, 1);
  assert.equal(sold.items[1].stock, 1);
  assert.equal(sold.sales.length, 2);
  assert.equal(sold.sales[0].saleNumber, sold.sales[1].saleNumber);
  assert.equal(sold.sales[0].subtotal + sold.sales[1].subtotal, 590);
});

test('stores the checkout operator name on every sale line', () => {
  const stocked = withSalesperson(addItem(emptyState(), item));
  const sold = recordSaleBatch(stocked, {
    salespersonId: stocked.salespeople[0].id,
    createdBy: 'clerk-1',
    createdByAccount: '王業務',
    lines: [{ barcode: item.barcode, quantity: 1 }],
  });

  assert.equal(sold.sales[0].createdBy, 'clerk-1');
  assert.equal(sold.sales[0].createdByAccount, '王業務');
});

test('defaults warranty months to zero and rejects non-integer or negative months', () => {
  assert.equal(addItem(emptyState(), item).items[0].warrantyMonths, 0);
  for (const warrantyMonths of [-1, 1.5, 'abc']) {
    assert.throws(() => addItem(emptyState(), { ...item, warrantyMonths }), /保固月數/);
  }
  const stocked = addItem(emptyState(), item);
  assert.throws(() => updateItem(stocked, stocked.items[0].id, { ...item, warrantyMonths: -1 }), /保固月數/);
});

test('loads old backups with no historical warranties', () => {
  const old = validateState({ items: [{ ...item, id: 'old-item' }], transactions: [], sales: [{ id: 'old-sale', itemId: 'old-item' }] });
  assert.equal(old.items[0].warrantyMonths, 0);
  assert.equal(old.warranties.length, 0);
  assert.equal(old.warrantyCases.length, 0);
});

test('creates manual warranty with date and item snapshots', () => {
  const stocked = addItem(emptyState(), { ...item, warrantyMonths: 1 });
  const ready = addCustomer(stocked, { name: '王小明', phone: '0912' });
  const warranty = createWarranty(ready, { customerId: ready.customers[0].id, itemId: ready.items[0].id, purchasedAt: '2026-01-31', expiresAt: '2026-02-28', note: '收據已核對', createdBy: '管理員' });
  const renamed = updateItem(warranty, ready.items[0].id, { ...ready.items[0], name: '新名稱', barcode: '4710000000098' });
  assert.equal(warranty.warranties[0].source, 'manual');
  assert.equal(warranty.warranties[0].note, '收據已核對');
  assert.equal(warranty.warranties[0].createdBy, '管理員');
  assert.equal(renamed.warranties[0].itemName, '前煞車皮');
  assert.equal(renamed.warranties[0].barcode, '4710000000012');
  assert.equal(renamed.warranties[0].purchasedAt, '2026-01-31');
  assert.equal(renamed.warranties[0].expiresAt, '2026-02-28');
  assert.equal(JSON.stringify(validateState(JSON.parse(toBackup(renamed)))), JSON.stringify(renamed));
});

test('rejects manual warranties without valid references or ordered dates', () => {
  const ready = addCustomer(addItem(emptyState(), item), { name: '王小明', phone: '0912' });
  const fields = { customerId: ready.customers[0].id, itemId: ready.items[0].id, purchasedAt: '2026-01-31', expiresAt: '2026-02-28' };
  assert.throws(() => createWarranty(ready, { ...fields, customerId: '' }), /客戶/);
  assert.throws(() => createWarranty(ready, { ...fields, itemId: '' }), /品項/);
  assert.throws(() => createWarranty(ready, { ...fields, purchasedAt: '2026-02-30' }), /購買日期/);
  assert.throws(() => createWarranty(ready, { ...fields, expiresAt: '2026-01-30' }), /到期日期/);
});

test('updates and deletes warranties and their cases', () => {
  const ready = addCustomer(addItem(emptyState(), item), { name: '王小明', phone: '0912' });
  const created = createWarranty(ready, { customerId: ready.customers[0].id, itemId: ready.items[0].id, purchasedAt: '2026-01-01', expiresAt: '2026-12-31' });
  const warrantyId = created.warranties[0].id;
  const updated = updateWarranty(created, warrantyId, { expiresAt: '2027-01-01', note: '延後' });
  assert.equal(updated.warranties[0].expiresAt, '2027-01-01');
  assert.equal(updated.warranties[0].note, '延後');
  const withCase = addWarrantyCase(updated, { warrantyId, issue: '無法啟動', createdBy: '店員' });
  assert.equal(withCase.warrantyCases[0].status, 'pending');
  const caseId = withCase.warrantyCases[0].id;
  const progressed = updateWarrantyCase(withCase, caseId, { status: 'in_progress', resolutionNote: '檢測中', handledAt: '2026-02-01' });
  assert.equal(progressed.warrantyCases[0].status, 'in_progress');
  assert.equal(progressed.warrantyCases[0].resolutionNote, '檢測中');
  assert.equal(deleteWarrantyCase(progressed, caseId).warrantyCases.length, 0);
  assert.equal(deleteWarranty(progressed, warrantyId).warrantyCases.length, 0);
  assert.equal(deleteWarranty(progressed, warrantyId).warranties.length, 0);
});

test('allows only the four repair case statuses', () => {
  const ready = addCustomer(addItem(emptyState(), item), { name: '王小明', phone: '0912' });
  const created = createWarranty(ready, { customerId: ready.customers[0].id, itemId: ready.items[0].id, purchasedAt: '2026-01-01', expiresAt: '2026-12-31' });
  for (const status of ['pending', 'in_progress', 'completed', 'not_covered']) {
    const next = addWarrantyCase(created, { warrantyId: created.warranties[0].id, issue: '異音', status });
    assert.equal(next.warrantyCases[0].status, status);
  }
  assert.throws(() => addWarrantyCase(created, { warrantyId: created.warranties[0].id, issue: '異音', status: 'closed' }), /狀態/);
});

test('filters warranties by text, expiry, and cases in progress', () => {
  const ready = addCustomer(addItem(emptyState(), item), { name: '王小明', phone: '0912' });
  const created = createWarranty(ready, { customerId: ready.customers[0].id, itemId: ready.items[0].id, purchasedAt: '2026-01-01', expiresAt: '2026-10-20' });
  assert.equal(warrantiesForFilter(created, { query: '王小明' }).length, 1);
  assert.equal(warrantiesForFilter(created, { query: '不存在' }).length, 0);
  assert.equal(warrantiesForFilter(created, { status: 'expiring', today: '2026-10-10' }).length, 1);
  assert.equal(warrantiesForFilter(created, { status: 'expired', today: '2026-10-21' }).length, 1);
  const withCase = addWarrantyCase(created, { warrantyId: created.warranties[0].id, issue: '異音', status: 'in_progress' });
  assert.equal(warrantiesForFilter(withCase, { status: 'in_progress' }).length, 1);
});

test('creates one warranty per eligible checkout line using calendar months', () => {
  const first = addItem(emptyState(), { ...item, stock: 4, warrantyMonths: 1 });
  const second = addItem(first, { ...item, name: '燈泡', barcode: '4710000000029', warrantyMonths: 12 });
  const third = addItem(second, { ...item, name: '機油', barcode: '4710000000036', warrantyMonths: 0 });
  const ready = withSalesperson(addCustomer(third, { name: '王小明', phone: '0912' }));
  const sold = recordSaleBatch(ready, { customerId: ready.customers[0].id, salespersonId: ready.salespeople[0].id, lines: [{ barcode: item.barcode, quantity: 1 }, { barcode: '4710000000029', quantity: 1 }, { barcode: '4710000000036', quantity: 1 }] });
  assert.equal(sold.warranties.length, 2);
  assert.equal(sold.warranties[0].saleId, sold.sales[0].id);
  assert.equal(sold.warranties[0].saleNumber, sold.sales[0].saleNumber);
  const purchase = new Date(`${sold.warranties[0].purchasedAt}T00:00:00Z`);
  const expectedMonth = new Date(Date.UTC(purchase.getUTCFullYear(), purchase.getUTCMonth() + 1, Math.min(purchase.getUTCDate(), new Date(Date.UTC(purchase.getUTCFullYear(), purchase.getUTCMonth() + 2, 0)).getUTCDate()))).toISOString().slice(0, 10);
  assert.equal(sold.warranties[0].expiresAt, expectedMonth);
});

test('preserves the supplied creator on automatic warranties', () => {
  const stocked = addItem(emptyState(), { ...item, warrantyMonths: 6 });
  const ready = withSalesperson(addCustomer(stocked, { name: '王小明', phone: '0912' }));
  const sold = recordSaleBatch(ready, {
    salespersonId: ready.salespeople[0].id,
    customerId: ready.customers[0].id,
    createdBy: 'authenticated-user-id',
    lines: [{ barcode: item.barcode, quantity: 1 }],
  });

  assert.equal(sold.warranties[0].createdBy, 'authenticated-user-id');
});

test('clamps January 31 warranty expiry to February month end', () => {
  const originalDate = context.Date;
  context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : ['2024-01-31T12:00:00.000Z'])); }
  };
  try {
    const stocked = addItem(emptyState(), { ...item, warrantyMonths: 1 });
    const ready = withSalesperson(addCustomer(stocked, { name: '王小明', phone: '0912' }));
    const sold = recordSaleBatch(ready, { customerId: ready.customers[0].id, salespersonId: ready.salespeople[0].id, lines: [{ barcode: item.barcode, quantity: 1 }] });
    assert.equal(sold.warranties[0].purchasedAt, '2024-01-31');
    assert.equal(sold.warranties[0].expiresAt, '2024-02-29');
  } finally {
    if (originalDate === undefined) delete context.Date;
    else context.Date = originalDate;
  }
});

test('uses Taipei calendar date for checkout and default expiry filter just after midnight', () => {
  const originalDate = context.Date;
  context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-10-09T16:30:00.000Z'])); }
  };
  try {
    const stocked = addItem(emptyState(), { ...item, warrantyMonths: 1 });
    const ready = withSalesperson(addCustomer(stocked, { name: '王小明', phone: '0912' }));
    const sold = recordSaleBatch(ready, { customerId: ready.customers[0].id, salespersonId: ready.salespeople[0].id, lines: [{ barcode: item.barcode, quantity: 1 }] });
    assert.equal(sold.sales[0].createdAt, '2026-10-09T16:30:00.000Z');
    assert.equal(sold.warranties[0].purchasedAt, '2026-10-10');
    assert.equal(sold.warranties[0].expiresAt, '2026-11-10');
    const old = createWarranty(ready, { customerId: ready.customers[0].id, itemId: ready.items[0].id, purchasedAt: '2026-01-01', expiresAt: '2026-10-09' });
    assert.equal(warrantiesForFilter(old, { status: 'expired' }).length, 1);
  } finally {
    if (originalDate === undefined) delete context.Date;
    else context.Date = originalDate;
  }
});

test('checkout without customer remains valid and failed checkout leaves no warranties', () => {
  const ready = withSalesperson(addItem(emptyState(), { ...item, warrantyMonths: 6 }));
  const sold = recordSaleBatch(ready, { salespersonId: ready.salespeople[0].id, lines: [{ barcode: item.barcode, quantity: 1 }] });
  assert.equal(sold.warranties.length, 0);
  assert.throws(() => recordSaleBatch(ready, { customerId: 'missing', lines: [{ barcode: item.barcode, quantity: 3 }] }), /庫存不足/);
  assert.equal(ready.warranties.length, 0);
});

test('replacing parts under an expired warranty needs a manager and is marked', () => {
  let state = addItem(emptyState(), { ...item, warrantyMonths: 1, stock: 3 });
  state = addCustomer(state, { name: '王小明', phone: '0912' });
  const base = { customerId: state.customers[0].id, itemId: state.items[0].id, createdBy: '管理員' };
  state = createWarranty(state, { ...base, purchasedAt: '2020-01-01', expiresAt: '2020-02-01', note: '已過期' });
  state = createWarranty(state, { ...base, purchasedAt: '2020-01-01', expiresAt: '2999-12-31', note: '有效' });
  const [expired, valid] = state.warranties;
  const fields = { type: 'warranty_out', itemId: state.items[0].id, quantity: 1, createdBy: 'clerk', note: '故障更換' };

  assert.throws(() => recordTransaction(state, { ...fields, warrantyId: expired.id }), /2020-02-01 到期，僅店長可放行/);
  const allowed = recordTransaction(state, { ...fields, warrantyId: expired.id, allowExpiredWarranty: true });
  assert.equal(allowed.transactions.at(-1).note, '[過期保固放行] 故障更換');
  assert.equal(allowed.items[0].stock, 2);
  const normal = recordTransaction(state, { ...fields, warrantyId: valid.id });
  assert.equal(normal.transactions.at(-1).note, '故障更換');
});
