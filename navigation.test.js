import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function purchasingUi() {
  const inventoryContext = { crypto: webcrypto, window: {} };
  vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), inventoryContext);
  const inventory = inventoryContext.window.Inventory;
  const elements = new Map();
  function node(id = '') {
    return { id, value: '', textContent: '', hidden: false, disabled: false, dataset: {}, children: [], listeners: {}, classList: { toggle() {} },
      addEventListener(type, handler) { this.listeners[type] = handler; }, setAttribute(key, value) { this[key] = value; }, replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, focus() {},
      reset() { for (const [key, element] of elements) if (key.startsWith(id.replace('-form', '') + '-') && !key.endsWith('-list')) element.value = ''; },
    };
  }
  const $ = (id) => { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); };
  const context = {
    ...inventory, state: inventory.emptyState(), currentUser: { id: 'manager' }, receiptPurchaseId: '', receiptSerialNumbersByItem: {}, $, document: { body: { dataset: { role: 'admin' } }, createElement: node },
    Option: function(label, value) { return { textContent: label, value, disabled: false }; },
    formatNumber: (value) => String(value), setStatus(message) { context.status = message; },
    clearFormError(id) { $(`${id}-error`).hidden = true; }, showFormError(id, message) { $(`${id}-error`).textContent = message; $(`${id}-error`).hidden = false; },
    confirm: () => true, render() {}, saves: 0,
  };
  context.saveState = async (next) => { context.saves++; context.state = next; return true; };
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function supplierName(');
  assert.ok(start >= 0, 'supplier UI is implemented');
  vm.runInNewContext(app.slice(start, app.indexOf('function renderCustomers()')), context);
  const submit = async (id) => $(id).listeners.submit({ preventDefault() {} });
  const click = async (id, dataset) => $(id).listeners.click({ target: { closest: () => ({ dataset }) } });
  return { context, $, submit, click, inventory };
}

test('customer form stores multiple optional plates and shows them on edit', async () => {
  const { context, $, inventory } = await purchasingUi();
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  vm.runInNewContext(app.slice(app.indexOf('function renderCustomers()'), app.indexOf('function renderSalespeople()')), context);
  $('customer-name').value = '王小明'; $('customer-phone').value = '0912';
  $('customer-plates').value = 'ABC-1234\nDEF-5678';
  await $('customer-form').listeners.submit({ preventDefault() {} });
  assert.deepEqual(Array.from(context.state.customers[0].plateNumbers), ['ABC-1234', 'DEF-5678']);
  const id = context.state.customers[0].id;
  $('customer-list').listeners.click({ target: { closest: () => ({ dataset: { customerAction: 'edit', id } }) } });
  assert.equal($('customer-plates').value, 'ABC-1234\nDEF-5678');
  context.renderCustomers();
  assert.match($('customer-list').children[0].children.map(cell => cell.textContent).join(' '), /ABC-1234/);
  assert.equal(inventory.validateState(context.state).customers[0].plateNumbers.length, 2);
});

test('supplier UI creates edits searches and deactivates suppliers with role guards', async () => {
  const { context, $, submit, click } = await purchasingUi();
  $('supplier-name').value = '電池供應商';
  $('supplier-phone').value = '0912345678';
  await submit('supplier-form');
  assert.equal(context.state.suppliers[0].name, '電池供應商');
  const id = context.state.suppliers[0].id;
  await click('supplier-list', { supplierAction: 'edit', id });
  assert.equal($('supplier-id').value, id);
  $('supplier-name').value = '新供應商';
  await submit('supplier-form');
  $('supplier-search').value = 'no match';
  context.renderSuppliers();
  assert.equal($('supplier-list').children.length, 1);
  assert.match($('supplier-list').children[0].children[0].textContent, /沒有/);
  $('supplier-search').value = '';
  await click('supplier-list', { supplierAction: 'deactivate', id });
  assert.equal(context.state.suppliers[0].active, false);
  const saves = context.saves;
  context.document.body.dataset.role = 'clerk';
  $('supplier-name').value = '非法';
  await submit('supplier-form');
  await click('supplier-list', { supplierAction: 'deactivate', id });
  assert.equal(context.saves, saves);
});

test('item supplier selector keeps active selection and shows only its existing inactive association', async () => {
  const { context, $, inventory } = await purchasingUi();
  context.state = inventory.addSupplier(context.state, { name: 'A' });
  context.state = inventory.addSupplier(context.state, { name: 'B' });
  const [a, b] = context.state.suppliers;
  $('item-supplier').value = a.id;
  context.renderItemSuppliers();
  assert.equal($('item-supplier').value, a.id);
  context.state = inventory.addItem(context.state, { name: '產品', category: '零件', supplierId: b.id, cost: 1, price: 2, stock: 0, minimumStock: 0 });
  context.state = inventory.deactivateSupplier(context.state, b.id);
  $('item-id').value = context.state.items[0].id;
  $('item-supplier').value = b.id;
  context.renderItemSuppliers();
  assert.match($('item-supplier').children.find((option) => option.value === b.id).textContent, /停用/);
  $('item-id').value = '';
  $('item-supplier').value = '';
  context.renderItemSuppliers();
  assert.equal($('item-supplier').children.some((option) => option.value === b.id), false);
});

async function stockedPurchasingUi() {
  const ui = await purchasingUi();
  const { context, inventory: I, $ } = ui;
  context.state = I.addSupplier(context.state, { name: 'A' });
  context.state = I.addSupplier(context.state, { name: 'B' });
  const [a, b] = context.state.suppliers;
  for (const [name, barcode] of [['一號', '1111111111111'], ['二號', '2222222222222']]) {
    context.state = I.addItem(context.state, { name, barcode, category: '零件', supplierId: a.id, cost: 1.234, price: 5, stock: 0, minimumStock: 0 });
  }
  assert.equal(typeof context.resetPurchaseForm, 'function', 'purchase UI is implemented');
  context.resetPurchaseForm();
  $('purchase-supplier').value = a.id;
  $('purchase-supplier').listeners.change();
  return { ...ui, a, b };
}

test('purchase builder preserves lines on cancelled supplier changes and renders editable totals', async () => {
  const { context, $, a, b } = await stockedPurchasingUi();
  const add = async (index) => {
    $('purchase-item').value = context.state.items[index].id;
    $('purchase-item').listeners.change();
    assert.equal($('purchase-unit-cost').value, '1.23');
    $('purchase-quantity').value = '2';
    await $('purchase-add-line').listeners.click();
  };
  await add(0); await add(1);
  assert.equal($('purchase-total').textContent, '4.92');
  await add(0);
  assert.match($('purchase-form-error').textContent, /重複|已有/);
  context.renderPurchaseBuilder();
  assert.equal($('purchase-lines').children.length, 2);
  await $('purchase-lines').listeners.change({ target: { dataset: { purchaseLine: '0', field: 'quantity' }, value: '3' } });
  assert.equal($('purchase-total').textContent, '6.15');
  context.confirm = () => false;
  $('purchase-supplier').value = b.id;
  $('purchase-supplier').listeners.change();
  assert.equal($('purchase-supplier').value, a.id);
  assert.equal($('purchase-lines').children.length, 2);
  context.confirm = () => true;
  $('purchase-supplier').value = b.id;
  $('purchase-supplier').listeners.change();
  assert.equal($('purchase-total').textContent, '0');
});

test('purchase UI saves drafts, receives once with confirmation, and records payment as manager', async () => {
  const { context, $, submit, click } = await stockedPurchasingUi();
  $('purchase-item').value = context.state.items[0].id;
  $('purchase-quantity').value = '2';
  $('purchase-unit-cost').value = '10';
  await $('purchase-add-line').listeners.click();
  await submit('purchase-form');
  const pid = context.state.purchases[0].id;
  assert.equal(context.state.purchases[0].createdBy, 'manager');
  assert.equal(context.state.items[0].stock, 0);
  context.confirm = () => false;
  await click('purchase-list', { purchaseAction: 'receive', id: pid });
  assert.equal(context.state.items[0].stock, 0);
  context.confirm = () => true;
  const before = context.saves;
  await click('purchase-list', { purchaseAction: 'receive', id: pid });
  assert.equal(context.saves, before + 1);
  assert.equal(context.state.items[0].stock, 2);
  assert.equal(context.state.purchases[0].receivedBy, 'manager');
  await click('purchase-list', { purchaseAction: 'paid', id: pid });
  assert.equal(context.state.purchases[0].paidBy, 'manager');
  const saves = context.saves;
  context.document.body.dataset.role = 'clerk';
  await submit('purchase-form');
  await click('purchase-list', { purchaseAction: 'delete', id: pid });
  assert.equal(context.saves, saves);
});

test('receipt UI retains draft and prevents repeated actions during failed or pending saves', async () => {
  const { context, $, click, inventory: I, a } = await stockedPurchasingUi();
  context.state = I.createPurchase(context.state, { supplierId: a.id, lines: [{ itemId: context.state.items[0].id, quantity: 1, unitCost: 2 }] });
  const pid = context.state.purchases[0].id;
  await click('purchase-list', { purchaseAction: 'edit', id: pid });
  assert.equal($('purchase-id').value, pid);
  let resolve;
  context.saveState = () => { context.saves++; return new Promise((done) => { resolve = done; }); };
  const pending = click('purchase-list', { purchaseAction: 'receive', id: pid });
  await click('purchase-list', { purchaseAction: 'receive', id: pid });
  assert.equal(context.saves, 1);
  resolve(false);
  await pending;
  assert.equal(context.state.purchases[0].status, 'draft');
  assert.equal(context.state.items[0].stock, 0);
  assert.equal($('purchase-id').value, pid);
  assert.notEqual(context.status, '進貨已收貨，庫存與成本已更新。');
  context.saveState = async (next) => { context.state = next; return true; };
  await click('purchase-list', { purchaseAction: 'receive', id: pid });
  assert.equal(context.state.items[0].stock, 1);
  assert.equal($('purchase-id').value, '');
});

test('actual app saveState leaves receipt and editor unchanged on storage failure', async () => {
  const { context, $, click, inventory: I, a } = await stockedPurchasingUi();
  context.state = I.createPurchase(context.state, { supplierId: a.id, lines: [{ itemId: context.state.items[0].id, quantity: 1, unitCost: 2 }] });
  const pid = context.state.purchases[0].id;
  await click('purchase-list', { purchaseAction: 'edit', id: pid });
  context.InventoryStorage = { async saveState() { throw new Error('disk full'); } };
  context.window = { AppAuthUI: { isActive: () => true } };
  context.appSessionEpoch = 0;
  context.pendingSave = null;
  context.setAppEnabled = () => {};
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  vm.runInNewContext(app.slice(app.indexOf('async function saveState('), app.indexOf('function itemName(')), context);
  await click('purchase-list', { purchaseAction: 'receive', id: pid });
  assert.match(context.status, /disk full/);
  assert.equal(context.state.items[0].stock, 0);
  assert.equal(context.state.purchases[0].status, 'draft');
  assert.equal($('purchase-id').value, pid);
});

test('import warns old backups clear suppliers and purchases and cancellation preserves all data', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const elements = new Map();
  const $ = (id) => { if (!elements.has(id)) elements.set(id, { listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } }); return elements.get(id); };
  const messages = [];
  let saves = 0;
  let backups = 0;
  const context = { $, state: { suppliers: [{ id: 'existing' }], purchases: [{ id: 'existing' }], serials: [{ id: 'serial' }] }, document: { body: { dataset: { role: 'admin' } } },
    validateState: (value) => ({ ...value, suppliers: value.suppliers ?? [], purchases: value.purchases ?? [] }),
    confirm(message) { messages.push(message); return false; }, saveState: async () => { saves++; return true; }, downloadBackup: () => backups++,
    resetItemForm() {}, resetSupplierForm() {}, resetPurchaseForm() {}, render() {}, setStatus() {},
  };
  vm.runInNewContext(app.slice(app.indexOf("$('import-file').addEventListener"), app.indexOf('function supplierName(')), context);
  await $('import-file').listeners.change({ target: { files: [{ text: async () => JSON.stringify({ items: [], transactions: [] }) }], value: 'backup.json' } });
  assert.match(messages[0], /供應商.*進貨/);
  assert.match(messages[0], /清空/);
  assert.match(messages[0], /序號/);
  assert.equal(saves, 0);
  assert.equal(backups, 0);
  assert.equal(context.state.suppliers[0].id, 'existing');
});

test('cloud migration requires an explicit backup file, admin role, and confirmation', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, { listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } }); return elements.get(id); };
  const calls = [];
  const context = { $, state: {}, currentUser: { role: 'clerk' }, appSessionEpoch: 0, window: { AppData: {
    migrateLocalStateToCloud: async (data, backup) => { calls.push('migrate'); await backup(data); return { migrated: true, state: data }; },
  } }, isMobileView: () => false, validateState: value => value,
  confirm: () => true, downloadBackup: () => calls.push('backup'), setStatus: () => {},
  render() {}, renderSaleCart() {}, showPage() {}, currentPage: () => 'list',
  setAppEnabled() {}, updateItemPrintButton() {}, renderTransactionItems() {}, resetWarrantyForm() {},
  };
  const start = app.indexOf("$('migration-file')?.addEventListener");
  assert.ok(start >= 0, 'migration control is implemented');
  vm.runInNewContext(app.slice(start, app.indexOf('function serialNumbersFromInput')), context);
  const file = { text: async () => JSON.stringify({ items: [] }) };
  await $('migration-file').listeners.change({ target: { files: [file], value: 'backup.json' } });
  assert.deepEqual(calls, []);
  context.currentUser.role = 'admin';
  await $('migration-file').listeners.change({ target: { files: [file], value: 'backup.json' } });
  assert.deepEqual(calls, ['migrate', 'backup']);
});

test('purchase clear button stays available after a draft is saved and reset', async () => {
  const { context, $ } = await stockedPurchasingUi();
  context.resetPurchaseForm();
  assert.equal($('purchase-cancel').hidden, false);
});

test('purchase line edits removal and record filters operate on the stored draft', async () => {
  const { context, $, click, submit } = await stockedPurchasingUi();
  for (const item of context.state.items) {
    $('purchase-item').value = item.id;
    $('purchase-quantity').value = '1'; $('purchase-unit-cost').value = '2';
    await $('purchase-add-line').listeners.click();
  }
  await $('purchase-lines').listeners.change({ target: { dataset: { purchaseLine: '0', field: 'unitCost' }, value: '3.25' } });
  await click('purchase-lines', { purchaseRemove: '1' });
  assert.equal($('purchase-total').textContent, '3.25');
  await submit('purchase-form');
  const purchase = context.state.purchases[0];
  assert.equal(purchase.lines.length, 1);
  assert.equal(purchase.lines[0].unitCost, 3.25);
  context.renderPurchases();
  assert.equal($('purchase-list').children[0].children[0].textContent, purchase.number);
  const actions = $('purchase-list').children[0].children.at(-1).children;
  assert.equal(actions.some((entry) => entry.dataset.purchaseAction === 'paid'), false);
  $('purchase-search').value = 'not found'; context.renderPurchases();
  assert.match($('purchase-list').children[0].children[0].textContent, /沒有/);
  $('purchase-search').value = 'A'; $('purchase-status-filter').value = 'received'; context.renderPurchases();
  assert.match($('purchase-list').children[0].children[0].textContent, /沒有/);
  $('purchase-status-filter').value = 'draft'; $('purchase-payment-filter').value = 'unpaid'; context.renderPurchases();
  assert.equal($('purchase-list').children[0].children[0].textContent, purchase.number);
  await click('purchase-list', { purchaseAction: 'view', id: purchase.id });
  assert.equal($('purchase-detail').hidden, false);
  await click('purchase-list', { purchaseAction: 'delete', id: purchase.id });
  assert.equal(context.state.purchases.length, 0);
});

test('whole app bootstrap integrates supplier and purchase tabs without missing DOM controls', async () => {
  const [html, inventorySource, app] = await Promise.all(['index.html', 'inventory.js', 'app.js'].map((file) => readFile(new URL(file, import.meta.url), 'utf8')));
  function node() {
    return { value: '', textContent: '', hidden: false, disabled: false, children: [], get selectedOptions() { return this.children.filter(child => child.selected); }, dataset: {}, listeners: {}, parentElement: { hidden: false },
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, listener) { this.listeners[type] = listener; }, append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; }, querySelector() { return node(); }, reset() {}, focus() {},
    };
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], node()]));
  const sections = new Map([...html.matchAll(/class="app-page[^>]*data-page="([^"]+)"[^>]*>/g)].map((match) => [match[1], { ...node(), dataset: { page: match[1], role: /data-role="admin"/.test(match[0]) ? 'admin' : '' } }]));
  const nav = node();
  const context = { crypto: webcrypto, window: { addEventListener() {} }, location: { hash: '#purchases' },
    document: { body: { dataset: { role: 'admin' }, classList: { add() {}, remove() {} } }, getElementById: (id) => elements.get(id) ?? null, createElement: node,
      querySelector: (query) => query === '.page-nav' ? nav : sections.get(query.match(/data-page="([^"]+)"/)?.[1]) ?? null,
      querySelectorAll: (query) => query === '.app-page[data-page]' ? [...sections.values()] : [],
    }, Option: function(label, value) { return { textContent: label, value }; },
  };
  vm.runInNewContext(inventorySource, context);
  let persisted = context.window.Inventory.emptyState();
  let ready;
  context.window.InventoryStorage = { loadState: async () => ({ state: persisted, migrated: false }), saveState: async (next) => { persisted = next; return next; } };
  context.window.AppAuthUI = { start(callback) { ready = callback({ id: 'manager' }); } };
  vm.runInNewContext(app, context);
  await ready;
  assert.doesNotMatch(elements.get('status').textContent, /失敗/);
  assert.equal(sections.get('purchases').hidden, false);
  assert.equal(sections.get('suppliers').hidden, true);
  elements.get('supplier-name').value = '供應商';
  await elements.get('supplier-form').listeners.submit({ preventDefault() {} });
  assert.equal(persisted.suppliers[0].name, '供應商');
  assert.match(elements.get('status').textContent, /供應商已儲存/);
  assert.equal(elements.get('item-supplier').children.at(-1).value, persisted.suppliers[0].id);
});

test('default purchase cost rounds decimal half ties up rather than binary toFixed rounding', async () => {
  const { context, $ } = await stockedPurchasingUi();
  for (const [cost, expected] of [[2.675, '2.68'], [1.005, '1.01'], [0.004, '0.00'], [1.234, '1.23'], [1.999, '2.00']]) {
    context.state.items[0].cost = cost;
    $('purchase-item').value = context.state.items[0].id;
    $('purchase-item').listeners.change();
    assert.equal($('purchase-unit-cost').value, expected);
  }
});

test('note-only unsaved drafts require confirmation before replacement clearing or supplier change', async () => {
  const { context, $, click, inventory: I, a, b } = await stockedPurchasingUi();
  context.state = I.createPurchase(context.state, { supplierId: a.id, lines: [{ itemId: context.state.items[0].id, quantity: 1, unitCost: 2 }] });
  const pid = context.state.purchases[0].id;
  $('purchase-note').value = '送貨前請先電話通知';
  let confirmations = 0;
  context.confirm = () => { confirmations++; return false; };
  await click('purchase-list', { purchaseAction: 'edit', id: pid });
  assert.equal($('purchase-note').value, '送貨前請先電話通知');
  assert.equal($('purchase-id').value, '');
  await $('purchase-cancel').listeners.click();
  assert.equal($('purchase-note').value, '送貨前請先電話通知');
  $('purchase-supplier').value = b.id;
  $('purchase-supplier').listeners.change();
  assert.equal($('purchase-supplier').value, a.id);
  assert.equal(confirmations, 3);
});

test('purchase operators snapshot each currently signed-in account without rewriting earlier operators', async () => {
  const { context, $, submit, click, inventory: I } = await stockedPurchasingUi();
  context.currentUser = { id: 'creator-id', email: 'creator@example.com', displayName: '建立者' };
  $('purchase-item').value = context.state.items[0].id;
  $('purchase-quantity').value = '1'; $('purchase-unit-cost').value = '2';
  await $('purchase-add-line').listeners.click();
  await submit('purchase-form');
  const pid = context.state.purchases[0].id;
  assert.equal(context.state.purchases[0].createdBy, 'creator-id');
  assert.equal(context.state.purchases[0].createdByAccount, '建立者');
  context.currentUser = { id: 'receiver-id', username: 'receiver' };
  await click('purchase-list', { purchaseAction: 'receive', id: pid });
  assert.equal(context.state.purchases[0].receivedBy, 'receiver-id');
  assert.equal(context.state.purchases[0].receivedByAccount, 'receiver');
  context.currentUser = { id: 'payer-id', username: 'payer' };
  await click('purchase-list', { purchaseAction: 'paid', id: pid });
  const purchase = context.state.purchases[0];
  assert.equal(purchase.paidByAccount, 'payer');
  assert.equal(purchase.createdByAccount, '建立者');
  assert.equal(I.validateState(JSON.parse(I.toBackup(context.state))).purchases[0].receivedByAccount, 'receiver');
  const paragraphs = $('purchase-detail').children.map((node) => node.textContent).join('\n');
  for (const label of ['建立者', 'receiver', 'payer']) assert.ok(paragraphs.includes(label));
  assert.equal(paragraphs.includes('creator-id'), false);
  context.currentUser = { id: 'another-user', email: 'another@example.com' };
  assert.equal(context.purchaseOperator('creator-id', 'creator@example.com'), 'creator@example.com');
  assert.equal(context.purchaseOperator('unknown-old-user', ''), 'unknown-old-user');
  assert.equal(context.purchaseOperator('another-user', ''), 'another-user');
});

test('defines four single-page tabs with customer and quotation controls', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  for (const page of ['list', 'manage', 'customers', 'salespeople', 'quotations']) assert.match(html, new RegExp(`data-page-target="${page}"`));
  for (const page of ['list', 'manage', 'customers', 'salespeople', 'quotations']) assert.match(html, new RegExp(`data-page="${page}"`));
  for (const id of ['item-form', 'customer-form', 'customer-list', 'salesperson-form', 'salesperson-list', 'quotation-form', 'quotation-salesperson', 'quotation-lines', 'quotation-list', 'print-quotation']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /href="manage\.html"/);
});

test('places sales management first in the main navigation', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const nav = html.match(/<nav class="page-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';

  assert.match(nav, /^\s*<nav[^>]*>\s*<button[^>]*data-page-target="sales"/);
});

test('limits mobile navigation to monthly sales only', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./style.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /data-page-target="monthly-sales"[^>]*data-mobile-page/);
  for (const page of ['list', 'manage']) assert.doesNotMatch(html, new RegExp(`data-page-target="${page}"[^>]*data-mobile-page`));
  assert.match(css, /\.page-tab:not\(\[data-mobile-page\]\) \{ display: none; \}/);
  assert.match(app, /const mobileAllowedPages = new Set\(\['monthly-sales'\]\)/);
  assert.match(app, /isMobileView\(\) && !mobileAllowedPages\.has\(page\)/);
  assert.match(app, /page = 'monthly-sales'/);
});

test('opens cloud operations on desktop while retaining mobile and clerk access limits', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
  ]);
  const buttons = new Map([...html.matchAll(/<button class="page-tab"[^>]*data-page-target="([^"]+)"[^>]*>/g)].map(([tag, page]) => [page, {
    dataset: { pageTarget: page, ...(tag.includes('data-cloud-disabled') ? { cloudDisabled: '' } : {}) },
    disabled: /\sdisabled(?:\s|>)/.test(tag),
    setAttribute() {}, removeAttribute() {},
  }]));
  const sections = new Map([...html.matchAll(/<section class="app-page[^"]*" data-page="([^"]+)"([^>]*)>/g)].map(([, page, attrs]) => [page, {
    dataset: { page, role: /data-role="admin"/.test(attrs) ? 'admin' : '' }, hidden: true,
  }]));
  let mobile = false;
  const context = {
    window: { matchMedia: () => ({ matches: mobile }) }, location: { hash: '' }, manageApproved: false, renderMonthlySales() {},
    document: {
      body: { dataset: { role: 'admin' } },
      querySelector(selector) {
        return selector.startsWith('[data-page-target=') ? buttons.get(selector.match(/data-page-target="([^"]+)"/)?.[1]) : sections.get(selector.match(/data-page="([^"]+)"/)?.[1]);
      },
      querySelectorAll(selector) { return selector === '[data-page-target]' ? [...buttons.values()] : [...sections.values()]; },
    },
  };
  vm.runInNewContext(app.slice(app.indexOf('const mobileAllowedPages'), app.indexOf('function setAppEnabled')), context);
  vm.runInNewContext(app.slice(app.indexOf('function showPage'), app.indexOf('function setStatus')), context);
  for (const page of ['suppliers', 'purchases', 'quotations', 'warranties', 'repairs']) {
    assert.equal(buttons.get(page).disabled, false, `${page} desktop tab is enabled`);
    assert.equal(buttons.get(page).dataset.cloudDisabled, undefined);
    context.location.hash = `#${page}`;
    assert.equal(context.currentPage(), page);
    context.showPage(page);
    assert.equal(sections.get(page).hidden, false);
  }
  context.document.body.dataset.role = 'clerk';
  for (const page of ['suppliers', 'purchases']) {
    context.showPage(page);
    assert.equal(sections.get(page).hidden, true);
    assert.equal(sections.get('sales').hidden, false);
  }
  mobile = true;
  context.showPage('quotations');
  assert.equal(sections.get('quotations').hidden, true);
  assert.equal(sections.get('monthly-sales').hidden, false);
  context.showPage('repairs');
  assert.equal(sections.get('repairs').hidden, true);
  assert.equal(sections.get('monthly-sales').hidden, false);
});

test('serial category selector offers valid motorcycle and battery options', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const select = html.match(/<select id="serial-category">([\s\S]*?)<\/select>/)?.[1] ?? '';

  assert.match(select, /<option value="機車">機車<\/option>/);
  assert.match(select, /<option value="電池">電池<\/option>/);
  assert.doesNotMatch(select, /<\/option\s+value=/);
});

test('loads the Supabase login gateway and keeps passwords out of local code', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

  assert.match(html, /<script src="inventory\.js\?v=\d+"><\/script>/);
  assert.match(html, /<script src="cloud-data\.js\?v=\d+"><\/script>/);
  assert.match(html, /<script src="cloud-data\.js\?v=11"><\/script>/, 'new cloud persistence must use a fresh asset URL');
  assert.match(html, /<script src="app\.js\?v=\d+"><\/script>/);
  assert.match(html, /<script src="app\.js\?v=36"><\/script>/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /id="login-password"[^>]*type="password"/);
  assert.match(html, /supabase-client\.js/);
  assert.match(html, /auth-ui\.js/);
  assert.doesNotMatch(html, /type="module"/);
});

test('declares role-gated controls and an authenticated app bootstrap', async () => {
  const [html, app, auth, client] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./auth-ui.js', import.meta.url), 'utf8'),
    readFile(new URL('./supabase-client.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="app-shell"/);
  assert.match(html, /data-role="admin"/);
  assert.match(html, /id="sign-out-button"/);
  assert.match(app, /AppAuthUI\.start/);
  assert.match(auth, /requireActiveUser/);
  assert.match(client, /signInWithPassword/);
});

test('does not mark untouched required fields as errors', async () => {
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');

  assert.doesNotMatch(css, /input:invalid:not\(:placeholder-shown\)/);
});

test('keeps hidden pages hidden even when they have layout classes', async () => {
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');

  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test('prints only the quotation document', async () => {
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');

  assert.match(css, /@media print/);
  assert.match(css, /\.print-document/);
});

test('uses hash routes and redirects legacy entry pages to the single app', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /addEventListener\('hashchange'/);
  assert.match(app, /requestPage\(button\.dataset\.pageTarget\)/);

  for (const [file, page] of [['manage.html', 'manage'], ['customers.html', 'customers'], ['quotations.html', 'quotations']]) {
    const html = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(html, new RegExp(`location\\.replace\\('index\\.html#${page}'\\)`));
  }
});

test('inventory management requires the current account password on every entry', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function openManageAuth(');
  assert.ok(start >= 0, 'inventory password gate is implemented');
  const end = app.indexOf('function backupTimestamp(', start);
  const elements = new Map();
  function node() { return { value: '', textContent: '', hidden: true, open: false, disabled: false, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, showModal() { this.open = true; }, close() { this.open = false; }, focus() {} }; }
  const $ = (id) => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const nav = node();
  let signIns = 0;
  const context = { $, currentUser: { id: 'manager', username: 'johnny', role: 'admin' }, manageApproved: false, location: { hash: '#customers' },
    showPage() {},
    document: { querySelector: (selector) => selector === '.page-nav' ? nav : null },
    window: { addEventListener() {}, AppAuth: { async signIn(username, password) { signIns++; return username === 'johnny' && password === 'correct-password' ? { error: null } : { error: new Error('帳號或密碼不正確') }; }, async requireActiveUser() { return context.currentUser; } } },
  };
  vm.runInNewContext(app.slice(start, end), context);
  nav.listeners.click({ target: { closest: () => ({ dataset: { pageTarget: 'manage' } }) } });
  assert.equal(context.location.hash, '#customers');
  assert.equal($('manage-auth-dialog').open, true);
  $('manage-auth-password').value = 'correct-password';
  await $('manage-auth-form').listeners.submit({ preventDefault() {} });
  assert.equal(signIns, 1);
  assert.equal(context.location.hash, 'manage');
  assert.equal($('manage-auth-dialog').open, false);
  context.location.hash = '#customers';
  nav.listeners.click({ target: { closest: () => ({ dataset: { pageTarget: 'manage' } }) } });
  assert.equal($('manage-auth-dialog').open, true);
});

test('exports timestamped backups and safeguards data before import', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /link\.download = `\$\{name\}-\$\{backupTimestamp\(\)\}\.json`/);
  assert.match(app, /downloadBackup\(state, 'motorcycle-inventory-before-import'\)/);
});

test('provides a print-only QR label that encodes the existing item identifier', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./style.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /qrcode-generator@2\.0\.4\/dist\/qrcode\.js/);
  assert.match(html, /id="qr-label"/);
  assert.match(html, /id="item-print-qr"/);
  assert.match(html, /13 碼數字.*QR Code/);
  assert.match(app, /qrcode\(0, 'M'\)/);
  assert.match(app, /dataset\.action = 'print-qr'/);
  assert.match(app, /item-print-qr/);
  assert.match(html, /<th>操作<\/th><\/tr><\/thead><tbody id="serial-list"/);
  assert.match(app, /dataset\.action = 'print-serial-qr'/);
  assert.match(app, /原廠序號：\$\{item\.serialNumber \|\| '未指定'\}/);
  assert.match(app, /showQrLabel\(\{ \.\.\.item, serialNumber: serial\.serialNumber \}\)/);
  assert.match(css, /printing-barcode/);
  assert.match(css, /body\.printing-barcode #qr-label/);
  assert.match(css, /\.qr-code \{ display: flex; justify-content: center; \}/);
});

test('encodes and scans a unit QR as item identifier plus manufacturer serial number', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /function parseUnitQr\(value\)/);
  assert.match(app, /qr\.addData\(item\.serialNumber \? `\$\{item\.barcode\}\|\$\{item\.serialNumber\}` : item\.barcode\)/);
  assert.match(app, /function handleTransactionScan\(decodedText\)[\s\S]{0,120}const scan = parseUnitQr\(decodedText\)/);
  assert.match(app, /renderTransactionSerials\(\);\s+clearFormError\('transaction-form'\);\s+if \(scan\.serialNumber\) selectTransactionSerial\(scan\.serialNumber\)/);
  assert.match(app, /selectTransactionSerial\(scan\.serialNumber\)/);
  assert.match(app, /const scan = parseUnitQr\(\$\('sale-barcode'\)\.value\)/);
  assert.match(app, /selectSaleSerial\(scan\.serialNumber\)/);
});

test('shows product details after a barcode scan', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="transaction-scan-result"/);
  assert.match(app, /showScannedItem\(item\)/);
});

test('supports scanning barcodes in the inventory search field', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /item-search'\)\?\.addEventListener\('keydown'/);
  assert.match(app, /找不到此條碼的品項/);
});

test('adds scanned sale items directly to the cart', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /sale-barcode'[\s\S]{0,700}addSaleLine/);
});

test('labels the sales scanner for QR Code while keeping the existing input field', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const saleForm = html.match(/<form id="sale-form">[\s\S]*?<\/form>/)?.[0] ?? '';

  assert.match(saleForm, /<label for="sale-barcode">掃描／輸入 QR Code<\/label>/);
  assert.match(saleForm, /id="sale-barcode"[^>]*placeholder="掃描 QR Code 後按 Enter"/);
  assert.match(saleForm, /掃描 QR Code 後會帶入品項；逐件 QR Code 會同時選取原廠序號。/);
});

test('keeps QR input workflows without camera scanning controls or dependency', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
  ]);

  for (const id of ['item-search', 'transaction-barcode', 'sale-barcode']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /function handleTransactionScan\(decodedText\)/);
  assert.match(app, /handleSaleScan\(decodedText\)/);
  assert.doesNotMatch(html, /id="(?:item|transaction|sale)-camera-(?:scan|stop|scanner|reader)"|html5-qrcode/);
  assert.doesNotMatch(app, /Html5Qrcode|getUserMedia|startCameraScan|startSaleCameraScan/);
});

test('allows checkout after a scanned barcode field has been cleared', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const saleForm = html.match(/<form id="sale-form">[\s\S]*?<\/form>/)?.[0] ?? '';

  assert.doesNotMatch(saleForm, /id="sale-barcode"[^>]*\srequired/);
});

test('does not expose item costs in the inventory list', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
  ]);
  const inventoryList = html.match(/<section aria-labelledby="inventory-title">[\s\S]*?<\/section>/)?.[0] ?? '';
  const renderItems = app.match(/function renderItems\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.doesNotMatch(inventoryList, /<th>成本<\/th>/);
  assert.doesNotMatch(renderItems, /formatNumber\(item\.cost\)/);
});

test('gives sales checkout and empty-cart guidance clear UI hooks', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /class="sale-scanner"/);
  assert.match(html, /class="sale-checkout"/);
  assert.match(app, /購物車目前沒有品項。請掃描條碼或輸入條碼後加入。/);
});

test('loads IndexedDB before enabling inventory actions', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /<script src="storage\.js\?v=1"><\/script>/);
  assert.match(app, /await InventoryStorage\.loadState\(\)/);
  assert.match(app, /await saveState\(next\)/);
  assert.match(app, /資料庫讀取失敗/);
});

test('exports a protection backup before awaiting IndexedDB import', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(app, /downloadBackup\(state, 'motorcycle-inventory-before-import'\);\s*if \(!await saveState\(imported\)\) return;/);
});

test('locks app actions while an IndexedDB save is in flight', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  let finish;
  const context={window:{AppAuthUI:{isActive:()=>true}},appSessionEpoch:0,pendingSave:null,state:{},InventoryStorage:{saveState:()=>new Promise(resolve=>{finish=resolve;})},setAppEnabled(value){context.enabled=value;},setStatus(){}};
  vm.runInNewContext(app.slice(app.indexOf('async function saveState('),app.indexOf('function itemName(')),context);
  const pending=context.saveState({});assert.equal(context.enabled,false);finish({saved:true});
  assert.equal(await pending,true);assert.equal(context.enabled,true);assert.equal(context.state.saved,true);
});

test('provides checkout customer, admin item warranty, and warranty management controls', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /data-page-target="warranties"/);
  assert.match(html, /data-page="warranties"/);
  assert.match(html, /id="sale-customer"/);
  assert.match(html, /id="item-warranty-months"[^>]*type="number"[^>]*min="0"/);
  for (const id of ['warranty-search', 'warranty-status', 'warranty-list', 'warranty-form', 'warranty-id', 'warranty-customer', 'warranty-item', 'warranty-purchased-at', 'warranty-expires-at', 'warranty-note', 'warranty-detail', 'warranty-case-form', 'warranty-case-id', 'warranty-case-issue', 'warranty-case-status', 'warranty-case-handled-at', 'warranty-case-resolution-note', 'warranty-case-list']) assert.match(html, new RegExp(`id="${id}"`));
  for (const value of ['active', 'expiring', 'expired', 'in_progress']) assert.match(html, new RegExp(`<option value="${value}"`));
});

test('connects customer checkout and warranty forms to validated inventory operations', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /recordSaleBatch\(state,\s*\{[^}]*customerId:\s*\$\('sale-customer'\)\.value/s);
  assert.match(app, /warrantyMonths:\s*\$\('item-warranty-months'\)\.value/);
  for (const helper of ['warrantiesForFilter', 'createWarranty', 'updateWarranty', 'addWarrantyCase', 'updateWarrantyCase']) assert.match(app, new RegExp(`${helper}\\(`));
  assert.match(app, /warranty-form'[\s\S]*?saveState\(next\)/);
  assert.match(app, /warranty-case-form'[\s\S]*?saveState\(next\)/);
});

test('checkout sends the authenticated bootstrap user as the warranty creator', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } });
    return elements.get(id);
  };
  $('sale-customer').value = 'customer-1';
  $('sale-salesperson').value = 'salesperson-1';
  let checkoutFields;
  const context = {
    $,
    window: {},
    InventoryStorage: { loadState: async () => ({ state: { items: [] }, migrated: false }) },
    recordSaleBatch(_state, fields) { checkoutFields = fields; return {}; },
    saveState: async () => false,
    render() {}, renderSaleCart() {}, currentPage: () => 'sales', showPage() {},
    setAppEnabled() {}, updateItemPrintButton() {}, renderTransactionItems() {}, resetWarrantyForm() {}, pendingSave: null, saleSerialItemId: '', saleSerialQuantity: 1,
    setStatus() {}, showFormError() {},
  };
  vm.runInNewContext(`let state; let saleCart = [{ barcode: '4710000000012', quantity: 1 }]; let currentUser = null;\n${app.slice(app.indexOf("if ($('sale-form'))"), app.indexOf('function renderMonthlySales('))}\n${app.slice(app.indexOf('async function bootstrap('), app.indexOf('window.AppAuthUI.start('))}`, context);

  await vm.runInNewContext("bootstrap({ id: 'authenticated-user-id' })", context);
  await $('sale-form').listeners.submit({ preventDefault() {} });
  assert.equal(checkoutFields.customerId, 'customer-1');
  assert.equal(checkoutFields.salespersonId, 'salesperson-1');
  assert.equal(checkoutFields.createdBy, 'authenticated-user-id');
});

test('shows salespeople in monthly sales only to administrators', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const elements = new Map();
  const node = () => ({ value: '', textContent: '', hidden: false, children: [], append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } });
  const $ = (id) => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const context = {
    $, document: { body: { dataset: { role: 'admin' } }, createElement: node },
    state: { items: [], transactions: [], customers: [], salespeople: [], quotations: [], warranties: [], warrantyCases: [], suppliers: [], purchases: [], serials: [], sales: [{ createdAt: '2026-10-12T09:00:00.000Z', itemName: '安全帽', barcode: '123', unitPrice: 500, quantity: 1, subtotal: 500, createdByAccount: '王業務', serialIds: [], serialNumbers: [] }] },
    salesForMonth: (state, month) => state.sales.filter((sale) => sale.createdAt.startsWith(month)), formatNumber: String,
    appendEmpty() {},
  };
  vm.runInNewContext(app.slice(app.indexOf('function renderMonthlySales('), app.indexOf("$('monthly-sales-month')?.addEventListener")), context);
  $('monthly-sales-month').value = '2026-10';

  context.renderMonthlySales();
  assert.equal($('monthly-salesperson-heading').hidden, false);
  assert.equal($('monthly-sales-list').children[0].children.at(-2).textContent, '王業務');

  context.document.body.dataset.role = 'clerk';
  context.renderMonthlySales();
  assert.equal($('monthly-salesperson-heading').hidden, true);
  assert.equal($('monthly-sales-list').children[0].children.length, 6);
});

test('monthly performance table is manager-only and distinguishes cashier from salesperson', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /id="monthly-performance-list"/);
  assert.match(html, /id="monthly-salesperson-heading"[^>]*>結帳人</);
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const nodes = new Map();
  const node = () => ({ value: '', textContent: '', hidden: false, children: [], append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } });
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  $('monthly-sales-month').value = '2026-10';
  let calls = 0;
  const context = { $, window: { AppData: { loadMonthlySalespersonPerformance: async () => { calls++; return [{ salespersonId: 'p1', name: '張業務', quantity: 3, total: 250 }]; }, loadMonthlySaleAssignments: async () => [] } },
    document: { body: { dataset: { role: 'admin' } }, createElement: node },
    state: { sales: [] }, salesForMonth: () => [], formatNumber: String, appendEmpty() {},
  };
  vm.runInNewContext(app.slice(app.indexOf('function renderMonthlySales('), app.indexOf("$('monthly-sales-month')?.addEventListener")), context);
  await context.renderMonthlySales(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal($('monthly-performance-list').children[0].children[0].textContent, '張業務');
  context.document.body.dataset.role = 'clerk';
  await context.renderMonthlySales(true);
  assert.equal($('monthly-performance-panel').hidden, true);
  assert.equal(calls, 1);
  context.document.body.dataset.role = 'admin';
  context.window.AppData.loadMonthlySalespersonPerformance = async () => { throw new Error('offline'); };
  await context.renderMonthlySales(true);
  assert.match($('monthly-performance-status').textContent, /無法載入.*offline/);
  assert.equal($('monthly-performance-list').children.length, 0);
  let resolveOld, resolveNew;
  context.window.AppData.loadMonthlySalespersonPerformance = month => new Promise(resolve => {
    if (month === '2026-10') resolveOld = resolve;
    else resolveNew = resolve;
  });
  const oldRequest = context.renderMonthlySales(true);
  $('monthly-sales-month').value = '2026-11';
  const newRequest = context.renderMonthlySales(true);
  resolveNew([{ name: '新月份', quantity: 1, total: 10 }]);
  await newRequest;
  resolveOld([{ name: '舊月份', quantity: 9, total: 90 }]);
  await oldRequest;
  assert.equal($('monthly-performance-list').children[0].children[0].textContent, '新月份');
});

test('manager backfills an unattributed whole sale from monthly list and staff cannot see the action', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /id="monthly-assignment-heading"/);
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const nodes = new Map();
  const node = () => ({ value: '', textContent: '', hidden: false, disabled: false, dataset: {}, children: [], listeners: {},
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    addEventListener(type, handler) { this.listeners[type] = handler; }, setAttribute(name, value) { this[name] = value; },
  });
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  $('monthly-sales-month').value = '2026-10';
  let assigned = false;
  const writes = [];
  const context = { $, window: { AppData: {
    loadMonthlySalespersonPerformance: async () => [],
    loadMonthlySaleAssignments: async () => [{ saleNumber: 'S1', salespersonId: assigned ? 'p1' : null, name: assigned ? '張業務' : null }],
    assignSaleSalesperson: async (saleNumber, salespersonId) => { writes.push([saleNumber, salespersonId]); assigned = true; },
  } }, Option: function(textContent, value) { return { textContent, value }; },
    document: { body: { dataset: { role: 'admin' } }, createElement: node },
    state: { salespeople: [{ id: 'p1', name: '張業務', active: true }], sales: [
      { saleNumber: 'S1', createdAt: '2026-10-12T09:00:00Z', itemName: 'A', barcode: '', unitPrice: 10, quantity: 1, subtotal: 10 },
      { saleNumber: 'S1', createdAt: '2026-10-12T09:00:00Z', itemName: 'B', barcode: '', unitPrice: 20, quantity: 1, subtotal: 20 },
    ] }, salesForMonth: state => state.sales, formatNumber: String, appendEmpty() {}, currentPage: () => 'monthly-sales', setStatus() {},
  };
  vm.runInNewContext(app.slice(app.indexOf('function renderMonthlySales('), app.indexOf('async function resetAppSession(')), context);
  await context.renderMonthlySales(true);
  const reloading = context.renderMonthlySales(true);
  assert.equal($('monthly-sales-list').children[0].children.at(-1).textContent, '載入中…');
  await reloading;
  const firstCell = $('monthly-sales-list').children[0].children.at(-1);
  const select = firstCell.children.find(child => child.children?.some(option => option.value === 'p1'));
  const button = firstCell.children.find(child => child.dataset.assignSale === 'S1');
  assert.ok(select && button);
  assert.equal($('monthly-sales-list').children[1].children.at(-1).textContent, '—');
  select.value = 'p1';
  await button.listeners.click();
  assert.deepEqual(writes, [['S1', 'p1']]);
  assert.equal($('monthly-sales-list').children[0].children.at(-1).textContent, '張業務');
  assigned = false;
  await context.renderMonthlySales(true);
  const raceCell = $('monthly-sales-list').children[0].children.at(-1);
  raceCell.children.find(child => child.children?.some(option => option.value === 'p1')).value = 'p1';
  context.window.AppData.assignSaleSalesperson = async () => { assigned = true; throw new Error('這張銷售單已歸屬業務員'); };
  await raceCell.children.find(child => child.dataset.assignSale === 'S1').listeners.click();
  assert.equal($('monthly-sales-list').children[0].children.at(-1).textContent, '張業務', 'a concurrent assignment must replace the stale form');
  context.document.body.dataset.role = 'clerk';
  context.renderMonthlySales();
  assert.equal($('monthly-assignment-heading').hidden, true);
  assert.equal($('monthly-sales-list').children[0].children.length, 6);
});

test('keeps warranty deletion admin-only and requires confirmation', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /document\.body\.dataset\.role === 'admin'/);
  assert.match(app, /section\?\.dataset\.role === 'admin'[\s\S]*?document\.body\.dataset\.role !== 'admin'/);
  assert.match(app, /deleteWarranty\(state,[\s\S]*?confirm\(|confirm\([\s\S]*?deleteWarranty\(state,/);
  assert.match(app, /deleteWarrantyCase\(state,[\s\S]*?confirm\(|confirm\([\s\S]*?deleteWarrantyCase\(state,/);
});

async function warrantyCaseUi() {
  const inventoryContext = { crypto: webcrypto, window: {} };
  vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), inventoryContext);
  const inventory = inventoryContext.window.Inventory;
  let state = inventory.addItem(inventory.emptyState(), { name: '煞車皮', category: '零件', barcode: '4710000000012', cost: 100, price: 200, stock: 2, minimumStock: 0 });
  state = inventory.addCustomer(state, { name: '王先生', phone: '0912345678' });
  for (const note of ['A', 'B']) state = inventory.createWarranty(state, { customerId: state.customers[0].id, itemId: state.items[0].id, purchasedAt: '2026-01-01', expiresAt: '2027-01-01', note });
  const [warrantyA, warrantyB] = state.warranties;
  state = inventory.addWarrantyCase(state, { warrantyId: warrantyA.id, issue: 'A 原故障', status: 'pending' });
  const caseA = state.warrantyCases[0];
  const elements = new Map();
  function node(id) {
    return { id, value: '', hidden: false, dataset: {}, children: [], parentElement: { hidden: false }, classList: { toggle() {} }, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, focus() {}, scrollIntoView() {} };
  }
  const $ = (id) => { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); };
  $('warranty-case-status').value = 'pending';
  $('warranty-form').reset = () => { for (const id of ['warranty-id', 'warranty-customer', 'warranty-item', 'warranty-purchased-at', 'warranty-expires-at', 'warranty-note']) $(id).value = ''; };
  $('warranty-case-form').reset = () => { for (const id of ['warranty-case-id', 'warranty-case-issue', 'warranty-case-handled-at', 'warranty-case-resolution-note']) $(id).value = ''; $('warranty-case-status').value = 'pending'; };
  const context = {
    state, selectedWarrantyId: warrantyA.id, currentUser: { id: 'staff' }, $, ...inventory,
    document: { body: { dataset: { role: 'clerk' } }, createElement: node },
    clearFormError(id) { $(`${id}-error`).hidden = true; },
    showFormError(id, message) { $(`${id}-error`).textContent = message; $(`${id}-error`).hidden = false; },
    render() {}, setStatus() {}, confirm: () => false,
  };
  context.saveState = async (next) => { context.state = next; return true; };
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  context.Option = function(label, value) { return { textContent: label, value }; };
  vm.runInNewContext(app.slice(app.indexOf('function renderWarrantySerials()'), app.indexOf('function showSaleItem(item)')), context);
  const click = async (id, dataset) => $(id).listeners.click({ target: { closest: () => ({ dataset }) } });
  context.renderWarrantyDetail();
  return { context, $, click, warrantyB, caseA };
}

test('switching warranties clears the repair case being edited', async () => {
  const { $, click, warrantyB, caseA } = await warrantyCaseUi();
  await click('warranty-case-list', { caseAction: 'edit', id: caseA.id });
  assert.equal($('warranty-case-id').value, caseA.id);
  await click('warranty-list', { warrantyAction: 'view', id: warrantyB.id });
  assert.equal($('warranty-case-id').value, '');
  assert.equal($('warranty-case-issue').value, '');
});

test('submitting after switching warranties creates a case on the selected warranty', async () => {
  const { context, $, click, warrantyB, caseA } = await warrantyCaseUi();
  await click('warranty-case-list', { caseAction: 'edit', id: caseA.id });
  await click('warranty-list', { warrantyAction: 'view', id: warrantyB.id });
  $('warranty-case-issue').value = 'B 新故障';
  await $('warranty-case-form').listeners.submit({ preventDefault() {} });
  assert.equal(context.state.warrantyCases.find((entry) => entry.id === caseA.id).issue, 'A 原故障');
  assert.equal(context.state.warrantyCases.find((entry) => entry.warrantyId === warrantyB.id)?.issue, 'B 新故障');
});

test('rejects a stale case ID from another selected warranty', async () => {
  const { context, $, click, warrantyB, caseA } = await warrantyCaseUi();
  await click('warranty-list', { warrantyAction: 'view', id: warrantyB.id });
  $('warranty-case-id').value = caseA.id;
  $('warranty-case-issue').value = '不應覆寫 A';
  await $('warranty-case-form').listeners.submit({ preventDefault() {} });
  assert.equal(context.state.warrantyCases.find((entry) => entry.id === caseA.id).issue, 'A 原故障');
  assert.equal($('warranty-case-form-error').hidden, false);
});

test('creating another warranty clears a repair case editor from the previous selection', async () => {
  const { context, $, click, caseA } = await warrantyCaseUi();
  await click('warranty-case-list', { caseAction: 'edit', id: caseA.id });
  $('warranty-customer').value = context.state.customers[0].id;
  $('warranty-item').value = context.state.items[0].id;
  $('warranty-purchased-at').value = '2026-02-01';
  $('warranty-expires-at').value = '2027-02-01';
  await $('warranty-form').listeners.submit({ preventDefault() {} });
  assert.equal(context.selectedWarrantyId, context.state.warranties.at(-1).id);
  assert.equal($('warranty-case-id').value, '');
});
