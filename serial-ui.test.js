import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
async function ui() {
  const context = { crypto: webcrypto, window: {} };
  vm.createContext(context);
  vm.runInContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
  Object.assign(context, context.window.Inventory);
  const nodes = new Map();
  function node() { return { value: '', textContent: '', dataset: {}, hidden: false, disabled: false, parentElement: { hidden: false }, children: [], listeners: {}, selected: false,
    get options() { return this.children; }, get selectedOptions() { return this.children.filter(n => n.selected); },
    replaceChildren(...children) { this.children = children; this.value = ''; }, append(...children) { this.children.push(...children); },
    addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {}, setAttribute(key, value) { this[key] = value; },
  }; }
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  Object.assign(context, { $, document: { createElement: node, body: { dataset: { role: 'admin' } } }, Option: function(text, value) { return { textContent: text, value, selected: false }; },
    currentUser: { id: 'manager', role: 'admin' }, pendingSave: null, receiptSerialNumbersByItem: {}, receiptPurchaseId: 'purchase', formatNumber: String, setStatus() {}, render() {},
    showFormError(id, message) { $(id + '-error').textContent = message; }, clearFormError(id) { $(id + '-error').textContent = ''; },
  });
  context.state = context.addItem(context.emptyState(), { category: '機車', name: '機車', sku: 'M', barcode: 'motor', stock: 0, cost: 1, price: 2, minimumStock: 0 });
  context.state.items[0].stock = 2;
  context.saveState = async next => { context.state = next; return true; };
  vm.runInContext(app.slice(app.indexOf('function serialNumbersFromInput('), app.indexOf('function supplierName(')), context);
  return context;
}
test('serial registration filters products by category and clears stale product selection', async () => {
  const c = await ui(), $ = c.$;
  c.state.items.push({ ...c.state.items[0], id: 'battery', name: '電池', category: '電池' });
  c.state.serials = [{ itemId: c.state.items[0].id, serialNumber: 'M1', status: 'in_stock' }, { itemId: 'battery', serialNumber: 'B1', status: 'in_stock' }];
  $('serial-category').value = '電池'; c.renderSerialInventory();
  assert.deepEqual(Array.from($('serial-item').children, option => option.value), ['', 'battery']);
  assert.equal($('serial-overview').children.length, 1);
  $('serial-item').value = 'battery'; $('serial-numbers').value = 'old draft';
  $('serial-category').value = '機車'; $('serial-category').listeners.change();
  assert.equal($('serial-item').value, ''); assert.equal($('serial-numbers').value, '');
  assert.deepEqual(Array.from($('serial-item').children, option => option.value), ['', c.state.items[0].id]);
  $('serial-category').value = ''; c.renderSerialInventory();
  assert.equal($('serial-item').children.length, 3);
});
test('manager registration preserves stock and failed save retains input', async () => {
  const c = await ui(), $ = c.$; $('serial-item').value = c.state.items[0].id;
  $('serial-numbers').value = '000123\n機車-B';
  await $('serial-form').listeners.submit({ preventDefault() {} });
  assert.equal(c.state.items[0].stock, 2); assert.equal(c.state.serials.length, 2);
  assert.equal(c.state.serials[0].serialNumber, '000123');
  assert.equal($('serial-numbers').value, '');
  const failure = await ui(); failure.$('serial-item').value = failure.state.items[0].id; failure.$('serial-numbers').value = 'X';
  failure.saveState = async () => false;
  await failure.$('serial-form').listeners.submit({ preventDefault() {} });
  assert.equal(failure.$('serial-numbers').value, 'X'); assert.equal(failure.state.serials.length, 0);
  failure.currentUser.role = 'clerk';
  await failure.$('serial-form').listeners.submit({ preventDefault() {} });
  assert.match(failure.$('serial-form-error').textContent, /店長/);
});
test('receipt input uses saved quantities and text safely without submitting on Enter', async () => {
  const c = await ui();
  c.renderPurchaseReceiptSerials({ lines: [{ itemId: c.state.items[0].id, quantity: 2 }] });
  assert.match(c.$('purchase-receipt-fields').children[0].children[0].textContent, /2/);
  const input = c.$('purchase-receipt-fields').children[0].children[1];
  input.value = '000A'; input.listeners.input();
  assert.deepEqual(Array.from(c.serialNumbersFromInput(input.value)), ['000A']);
});
test('manual warranty selects sold unit and shows its fixed customer and serial', async () => {
  const c = await ui();
  let state = c.addItem(c.emptyState(), { category: '機車', name: '機車', sku: 'M', barcode: 'motor', stock: 1, serialNumbers: ['000A'], cost: 1, price: 2, minimumStock: 0 });
  state = c.addCustomer(state, { name: '客戶', phone: '0912345678' });
  state = c.addSalesperson(state, { name: '測試業務' });
  c.state = c.recordSaleBatch(state, { customerId: state.customers[0].id, salespersonId: state.salespeople[0].id, lines: [{ itemId: state.items[0].id, quantity: 1, serialIds: [state.serials[0].id] }] });
  c.selectedWarrantyId = '';
  vm.runInContext(app.slice(app.indexOf('function renderSaleCustomers('), app.indexOf('function renderSalePicker()')), c);
  c.renderWarrantySelectors();
  c.$('warranty-serial').value = c.state.serials[0].id;
  c.$('warranty-serial').listeners.change();
  assert.equal(c.$('warranty-customer').value, state.customers[0].id);
  assert.equal(c.$('warranty-item').value, state.items[0].id);
  assert.equal(c.$('warranty-customer').disabled, true);
  assert.match(c.$('warranty-serial').children[1].textContent, /000A/);
});

async function fullUi(initial) {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const elements = new Map();
  function node(id = '') { return { id, value: '', textContent: '', hidden: false, disabled: false, children: [], dataset: {}, parentElement: { hidden: false }, listeners: {},
    get options() { return this.children; }, get selectedOptions() { return this.children.filter(option => option.selected); },
    classList: { toggle() {}, add() {}, remove() {} }, setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; },
    addEventListener(type, fn) { this.listeners[type] = fn; }, replaceChildren(...children) { this.children = children; this.value = ''; }, append(...children) { this.children.push(...children); },
    focus() {}, scrollIntoView() {}, querySelector() { return node(); }, closest() { return this; }, dispatchEvent(event) { this.listeners[event.type]?.({ ...event, currentTarget: this }); },
    reset() { for (const [key, element] of elements) if (key.startsWith(id.replace('-form', '') + '-') && !key.endsWith('-list')) element.value = ''; },
  }; }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], node(match[1]));
  const $ = id => elements.get(id) ?? null;
  const context = { crypto: webcrypto, window: { addEventListener() {} }, location: { hash: '#sales' }, Option: function(label, value) { return { textContent: label, value, selected: false }; }, Event: class { constructor(type) { this.type = type; } }, confirm: () => true,
    document: { body: { dataset: { role: 'admin' } }, getElementById: $, createElement: () => node(),
      querySelector: () => node(), querySelectorAll: query => query === '#app-shell form' ? [...elements.values()].filter(n => n.id.endsWith('-form')) : query.includes('tbody') ? [...elements.values()].filter(n => n.id.endsWith('-list') || n.id === 'sale-cart') : query.includes('button,') ? [...elements.values()] : [],
    },
  };
  vm.createContext(context);
  vm.runInContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
  const I = context.window.Inventory; let persisted = initial ?? I.emptyState(), failed = false;
  context.window.InventoryStorage = { loadState: async () => ({ state: I.validateState(persisted) }), saveState: async next => { if (failed) throw new Error('disk full'); persisted = I.validateState(next); return persisted; } };
  context.window.AppAuthUI = { isActive: () => true };
  const instrumented = app.replace('window.AppAuthUI.start(bootstrap, resetAppSession);', 'window.testAPI = { bootstrap, resetAppSession, addSaleItem, addSaleLine, getState: () => state, getCart: () => saleCart, getSerialSelection: () => saleSerialItemId, beginSaleSerialSelection };');
  vm.runInContext(instrumented, context);
  await context.window.testAPI.bootstrap({ id: 'manager', role: 'admin' });
  assert.doesNotMatch($('status').textContent, /失敗/);
  return { $, I, api: context.window.testAPI, context, fail(value) { failed = value; }, stored: () => persisted,
    submit: id => $(id).listeners.submit({ preventDefault() {} }),
    click: (id, dataset) => $(id).listeners.click({ target: dataset ? { closest: () => ({ dataset }) } : $(id) }),
  };
}
test('real app serial receipt preserves inputs on write failure and prevents duplicate receipt', async () => {
  const setup = await ui(); let state = setup.addSupplier(setup.emptyState(), { name: '供應商' });
  state = setup.addItem(state, { category: '機車', name: '機車', sku: 'M', barcode: 'motor', supplierId: state.suppliers[0].id, stock: 0, cost: 1, price: 2, minimumStock: 0 });
  state = setup.createPurchase(state, { supplierId: state.suppliers[0].id, lines: [{ itemId: state.items[0].id, quantity: 2, unitCost: 3 }] });
  const c = await fullUi(state), pid = state.purchases[0].id;
  await c.click('purchase-list', { id: pid, purchaseAction: 'receive' });
  const input = c.$('purchase-receipt-fields').children[0].children[1]; input.value = '000A';
  let prevented = false; input.listeners.keydown({ key: 'Enter', currentTarget: input, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(c.stored().items[0].stock, 0);
  input.value += 'B'; input.listeners.input();
  c.fail(true); await c.click('purchase-receipt-confirm');
  assert.equal(c.stored().items[0].stock, 0); assert.equal(input.value, '000A\nB');
  c.fail(false); await c.click('purchase-receipt-confirm');
  assert.equal(c.stored().items[0].stock, 2); assert.equal(c.stored().serials.length, 2);
  assert.equal(c.stored().serials[0].createdBy, 'manager');
  await c.click('purchase-list', { id: pid, purchaseAction: 'receive' });
  assert.equal(c.stored().items[0].stock, 2);
});
test('real app serial cart checkout preserves failure then creates per-unit warranty', async () => {
  const setup = await ui();
  let state = setup.addItem(setup.emptyState(), { category: '機車', name: '機車', sku: 'M', barcode: 'motor', stock: 2, cost: 1, price: 2, minimumStock: 0, warrantyMonths: 12, serialNumbers: ['000A', 'B'] });
  state = setup.addCustomer(state, { name: '客戶', phone: '0912345678' });
  state = setup.addSalesperson(state, { name: '測試業務' });
  const c = await fullUi(state), item = c.api.getState().items[0];
  c.api.beginSaleSerialSelection(item, 2);
  for (const value of ['000A', 'B']) { c.$('sale-serial-scan').value = value; c.$('sale-serial-scan').listeners.keydown({ key: 'Enter', currentTarget: c.$('sale-serial-scan'), preventDefault() {} }); }
  await c.click('sale-serial-add');
  assert.equal(c.api.getCart()[0].quantity, 2);
  c.$('sale-customer').value = state.customers[0].id;
  c.$('sale-salesperson').value = state.salespeople[0].id;
  c.api.beginSaleSerialSelection(item, 1);
  c.fail(true); await c.submit('sale-form');
  assert.equal(c.stored().items[0].stock, 2); assert.equal(c.api.getCart().length, 1);
  c.fail(false); await c.submit('sale-form');
  assert.equal(c.stored().items[0].stock, 0); assert.equal(c.stored().warranties.length, 2); assert.equal(c.api.getCart().length, 0);
  assert.equal(c.api.getSerialSelection(), '');
});
test('real app stock movement records signed-in manager and clerk cannot submit it', async () => {
  const c = await fullUi();
  const initial = c.I.addItem(c.I.emptyState(), { category: '機車', name: '機車', sku: 'M', barcode: 'motor', stock: 1, serialNumbers: ['000A'], cost: 1, price: 2, minimumStock: 0 });
  // Reuse storage load boundary rather than mutating the app's internal state.
  c.context.window.InventoryStorage.loadState = async () => ({ state: initial });
  await c.api.bootstrap({ id: 'manager', role: 'admin' });
  c.$('transaction-item').value = initial.items[0].id; c.$('transaction-type').value = 'out';
  c.$('transaction-item').listeners.change();
  c.$('transaction-serial-ids').children[0].selected = true;
  c.$('transaction-quantity').value = '1'; c.$('transaction-note').value = '報廢';
  await c.submit('transaction-form');
  assert.equal(c.stored().serials[0].removedBy, 'manager'); assert.equal(c.stored().items[0].stock, 0);
  await c.api.bootstrap({ id: 'clerk', role: 'clerk' });
  await c.submit('transaction-form'); assert.match(c.$('transaction-form-error').textContent, /店長/);
});
test('real app warranty issue selects original customer retains failed input and records replacement on original warranty', async () => {
  const setup = await ui();
  let state = setup.addItem(setup.emptyState(), { category: '機車', name: '機車', sku: 'M', barcode: 'motor', stock: 2, cost: 1, price: 2, minimumStock: 0, warrantyMonths: 12, serialNumbers: ['000A', 'B'] });
  state = setup.addCustomer(state, { name: '保固客戶', phone: '0912345678' });
  state = setup.addSalesperson(state, { name: '測試業務' });
  state = setup.recordSaleBatch(state, { customerId: state.customers[0].id, salespersonId: state.salespeople[0].id, lines: [{ itemId: state.items[0].id, quantity: 1, serialIds: [state.serials[0].id] }] });
  const c = await fullUi(state), $ = c.$;
  $('transaction-type').value = 'warranty_out'; $('transaction-item').value = state.items[0].id;
  $('transaction-type').listeners.change();
  assert.equal($('transaction-warranty-fields').hidden, false);
  assert.equal($('transaction-warranty').required, true);
  assert.match($('transaction-warranty').children[1].textContent, /保固客戶.*000A/);
  $('transaction-warranty').value = state.warranties[0].id; $('transaction-warranty').listeners.change();
  assert.match($('transaction-warranty-summary').textContent, /保固客戶/);
  assert.match($('transaction-warranty-summary').textContent, new RegExp(state.warranties[0].expiresAt));
  assert.equal($('transaction-serial-numbers').parentElement.hidden, true);
  assert.equal($('transaction-serial-ids').parentElement.hidden, false);
  $('transaction-serial-ids').children[0].selected = true;
  $('transaction-quantity').value = '1'; $('transaction-note').value = '免費換新';
  c.fail(true); await c.submit('transaction-form');
  assert.equal(c.stored().items[0].stock, 1); assert.equal(c.stored().transactions.length, state.transactions.length);
  assert.equal($('transaction-warranty').value, state.warranties[0].id);
  assert.equal($('transaction-note').value, '免費換新'); assert.equal($('transaction-warranty').disabled, false);
  c.fail(false);
  let release, writes = 0;
  const save = c.context.window.InventoryStorage.saveState;
  c.context.window.InventoryStorage.saveState = async next => { writes++; await new Promise(resolve => { release = resolve; }); return save(next); };
  const first = c.submit('transaction-form');
  await c.submit('transaction-form'); assert.equal(writes, 1);
  release(); await first;
  assert.equal(c.stored().items[0].stock, 0); assert.equal(c.stored().serials[1].status, 'warranty_out');
  assert.equal(c.stored().transactions.at(-1).createdBy, 'manager'); assert.equal(c.stored().sales.length, 1);
  await c.click('warranty-list', { id: state.warranties[0].id, warrantyAction: 'view' });
  assert.equal($('warranty-replacement-list').children.length, 1);
  assert.match($('warranty-replacement-list').children[0].children.map(cell => cell.textContent).join(' '), /B.*免費換新/);
  $('transaction-type').value = 'in'; $('transaction-type').listeners.change();
  assert.equal($('transaction-warranty-fields').hidden, true); assert.equal($('transaction-warranty').required, false);
  await c.api.bootstrap({ id: 'clerk', role: 'clerk' });
  await c.submit('transaction-form'); assert.match($('transaction-form-error').textContent, /店長/);
  await c.api.resetAppSession();
  assert.equal($('transaction-warranty').value, ''); assert.equal($('transaction-warranty').children.length, 0);
});
test('serial overview lists products and opens a per-product serial dialog with paging', async () => {
  const c = await ui(), $ = c.$;
  const itemId = c.state.items[0].id;
  c.state.items.push({ ...c.state.items[0], id: 'battery', name: '電池', category: '電池' });
  // 機車 45 筆序號（createdAt 越後面越新）＋電池 1 筆。
  c.state.serials = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, itemId, serialNumber: `SN${String(i).padStart(3, '0')}`, status: i % 3 === 0 ? 'sold' : 'in_stock', createdAt: `2026-10-${String(1 + Math.floor(i / 2)).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z` }));
  c.state.serials.push({ id: 'b1', itemId: 'battery', serialNumber: 'BAT-1', status: 'in_stock', createdAt: '2026-10-01T00:00:00Z' });
  c.renderSerialInventory();
  // 總覽：每個品項一列，顯示各狀態數量，不直接列出序號。
  assert.equal($('serial-overview').children.length, 2);
  const motorRow = $('serial-overview').children[0];
  assert.deepEqual(motorRow.children.slice(0, 4).map(cell => cell.textContent), ['機車', '機車', '30', '15']);
  assert.equal($('serial-list').children.length, 0);

  // 點「查看序號」→ 視窗列出該品項最新 20 筆，可再顯示更多。
  const open = id => $('serial-overview').listeners.click({ target: { closest: () => ({ dataset: { action: 'open-serial-dialog', id } }) } });
  open(itemId);
  assert.equal($('serial-dialog-title').textContent, '機車 的原廠序號');
  assert.equal($('serial-list').children.length, 20);
  assert.equal($('serial-list').children[0].children[0].textContent, 'SN044');
  assert.equal($('serial-list-count').textContent, '顯示 20／共 45 筆');
  $('serial-show-more').listeners.click(); $('serial-show-more').listeners.click();
  assert.equal($('serial-list').children.length, 45);
  assert.equal($('serial-show-more').hidden, true);
  // 視窗內搜尋：只列符合的，並回到從前 20 筆開始。
  $('serial-dialog-search').value = 'SN00'; $('serial-dialog-search').listeners.input();
  assert.equal($('serial-list').children.length, 10);

  // 總覽搜尋：只留下含此序號的品項，點進去時帶入同樣的搜尋字。
  $('serial-search').value = 'bat-1'; c.renderSerialInventory();
  assert.equal($('serial-overview').children.length, 1);
  open('battery');
  assert.equal($('serial-dialog-search').value, 'bat-1');
  assert.equal($('serial-list').children.length, 1);
  assert.equal($('serial-list').children[0].children[1].textContent, '在庫');
});
