import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
const source = await readFile(new URL('./repair-ui.js', import.meta.url), 'utf8').catch(() => '');
const context = { window: {} };
if (source) vm.runInNewContext(source, context);

test('repair navigation is desktop-only and has required intake and print anchors', () => {
  assert.match(html, /data-page-target="repairs"/);
  assert.doesNotMatch(html, /data-page-target="repairs"[^>]*data-mobile-page/);
  for (const id of ['repair-form', 'repair-list', 'repair-detail', 'repair-print', 'repair-original-serial']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(css, /body\.printing-repair #repair-print \{ display: block !important/);
});

test('repair search and battery selection only expose relevant data', () => {
  const { filterOrders, availableSerials, actionState } = context.window.RepairUI;
  const orders = [{ number: 'R-1', customerPhone: '0911', plateNumber: 'ABC', originalSerialNumber: 'S1' }, { number: 'R-2', customerPhone: '0922', plateNumber: 'DEF', originalSerialNumber: 'S2' }];
  assert.equal(filterOrders(orders, 's2')[0].number, 'R-2');
  assert.equal(filterOrders(orders, '0911')[0].number, 'R-1');
  const serials = [{ id: 'one', itemId: 'battery', status: 'in_stock' }, { id: 'two', itemId: 'battery', status: 'sold' }, { id: 'three', itemId: 'other', status: 'in_stock' }];
  assert.deepEqual(Array.from(availableSerials(serials, 'battery'), serial => serial.id), ['one']);
  assert.equal(actionState({ status: 'quoted', paymentStatus: 'unpaid' }).canComplete, true);
  assert.equal(actionState({ status: 'completed', paymentStatus: 'unpaid' }).canPay, true);
  assert.equal(actionState({ status: 'cancelled', paymentStatus: 'unpaid' }).canComplete, false);
  for (const status of ['intake', 'quoted', 'cancelled']) {
    assert.equal(actionState({ status, paymentStatus: 'unpaid' }, true).canDelete, true);
    assert.equal(actionState({ status, paymentStatus: 'unpaid' }, false).canDelete, false);
  }
  assert.equal(actionState({ status: 'completed' }, true).canDelete, false);
});

test('only a manager can confirm and delete an unfinished repair order', async () => {
  const nodes = new Map(), calls = [], confirms = [];
  function node(tag = 'div') { return { tag, value: '', textContent: '', hidden: false, disabled: false, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} },
    listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, append(...values) { this.children.push(...values); },
    replaceChildren(...values) { this.children = values; }, reset() {}, reportValidity: () => true }; }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const order = { id: 'repair-1', number: 'R-1', status: 'cancelled', paymentStatus: 'unpaid', customerName: '甲', customerPhone: '0911', lines: [] };
  let orders = [order], accepted = false;
  const browser = { addEventListener() {}, confirm: text => { confirms.push(text); return accepted; }, AppAuthUI: { isActive: () => true }, AppData: {
    loadRepairOrders: async () => orders,
    async deleteRepairOrder(id) { calls.push(id); orders = []; return { id, orders, state: { customers: [], items: [], serials: [] } }; },
  } };
  const document = { getElementById: get, createElement: node, body: { dataset: { role: 'staff' }, classList: { add() {}, remove() {} } } };
  vm.runInNewContext(source, { window: browser, document, Option: function Option(text, value) { return { text, value }; } });
  const ui = browser.RepairUI.mount({ getState: () => ({ customers: [], items: [], serials: [] }), setState() {}, notify() {} });
  await ui.load();
  const open = () => get('repair-list').listeners.click({ target: { closest: () => ({ dataset: { repairId: order.id } }) } });
  const remove = () => get('repair-detail').listeners.click({ target: { closest: () => ({ dataset: { repairAction: 'delete' } }) } });
  open();
  assert.equal(get('repair-detail').children.some(child => child.dataset.repairAction === 'delete'), false);
  remove();
  assert.deepEqual(calls, []);
  document.body.dataset.role = 'admin';
  open();
  assert.equal(get('repair-detail').children.some(child => child.dataset.repairAction === 'delete'), true);
  remove();
  assert.match(confirms[0], /R-1/);
  assert.deepEqual(calls, []);
  accepted = true;
  remove();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['repair-1']);
  assert.equal(get('repair-detail').hidden, true);
});

test('choosing a member with multiple plates offers a dropdown and copies the selected plate', () => {
  assert.match(html, /id="repair-plate-choice"/);
  const nodes = new Map();
  function node() { return { value: '', hidden: false, textContent: '', dataset: {}, children: [], classList: { toggle() {} },
    listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; }, reset() {}, reportValidity: () => true }; }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const browser = { addEventListener() {}, AppAuthUI: { isActive: () => true } };
  const document = { getElementById: get, createElement: node, body: { classList: { add() {}, remove() {} } } };
  vm.runInNewContext(source, { window: browser, document, Option: function Option(text, value) { return { text, value }; } });
  browser.RepairUI.mount({ getState: () => ({ customers: [
    { id: 'multi', name: '甲', phone: '0911', memberNumber: 'M000001', active: true, plateNumbers: ['ABC-1234', 'DEF-5678'] },
    { id: 'single', name: '乙', phone: '0922', memberNumber: 'M000002', active: true, plateNumbers: ['XYZ-9999'] },
  ], items: [], serials: [] }), setState() {}, notify() {} });
  get('repair-customer').value = 'multi'; get('repair-customer').listeners.change();
  assert.equal(get('repair-plate-choice-wrap').hidden, false);
  assert.deepEqual(get('repair-plate-choice').children.map(option => option.value), ['', 'ABC-1234', 'DEF-5678']);
  get('repair-plate-choice').value = 'DEF-5678'; get('repair-plate-choice').listeners.change();
  assert.equal(get('repair-plate').value, 'DEF-5678');
  get('repair-customer').value = 'single'; get('repair-customer').listeners.change();
  assert.equal(get('repair-plate-choice-wrap').hidden, true);
  assert.equal(get('repair-plate').value, 'XYZ-9999');
});

test('repair print shows customer, materials, serial, labor, and payment without parsing customer HTML', () => {
  const created = [];
  function node(tag) { return { tag, textContent: '', children: [], append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; } }; }
  const printArea = node('section');
  let printed = 0;
  const browser = { print: () => { printed++; } };
  const document = { createElement: tag => { const value = node(tag); created.push(value); return value; },
    getElementById: () => printArea, body: { classList: { add() {} } } };
  browser.RepairUI = null;
  vm.runInNewContext(source, { window: browser, document });
  browser.RepairUI.printRepairOrder({ number: 'R-1', status: 'completed', paymentStatus: 'unpaid', customerName: '<img src=x onerror=alert(1)>', customerPhone: '0911', plateNumber: 'ABC', originalSerialNumber: 'S1', vehicleName: '車型', issue: '故障', diagnosis: '已修', laborAmount: 100, total: 2100 },
    [{ id: 'line-1', itemName: '電池', quantity: 1, unitPrice: 2000, subtotal: 2000 }],
    [{ repairLineId: 'line-1', serialNumber: 'BAT-001' }]);
  const content = created.map(value => value.textContent).join('\n');
  for (const value of ['R-1', '未收款', '<img src=x onerror=alert(1)>', 'BAT-001', 'NT$ 100', 'NT$ 2,100']) assert.match(content, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(printed, 1);
  assert.ok(created.every(value => !Object.hasOwn(value, 'innerHTML')));
});

test('sign-out clear removes printed customer data and ignores a late repair list response', async () => {
  const nodes = new Map();
  function node(tag = 'div') { return { tag, value: '', textContent: '', hidden: false, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} },
    listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, append(...values) { this.children.push(...values); },
    replaceChildren(...values) { this.children = values; }, reset() {}, reportValidity: () => true }; }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  let resolveLoad;
  const browser = { print() {}, addEventListener() {}, AppAuthUI: { isActive: () => true },
    AppData: { loadRepairOrders: () => new Promise(resolve => { resolveLoad = resolve; }) } };
  const document = { getElementById: get, createElement: node, body: { classList: { add() {}, remove() {} } } };
  vm.runInNewContext(source, { window: browser, document, Option: function Option(text, value) { return { text, value }; } });
  const ui = browser.RepairUI.mount({ getState: () => ({ customers: [], items: [], serials: [] }), setState() {}, notify() {} });
  const pending = ui.load();
  browser.RepairUI.printRepairOrder({ number: 'R-1', status: 'intake', paymentStatus: 'unpaid', customerName: '私密姓名', customerPhone: '0911', laborAmount: 0, total: 0 }, []);
  assert.ok(get('repair-print').children.length > 0);
  ui.clear();
  resolveLoad([{ id: 'repair-1', number: 'R-1', customerName: '私密姓名', customerPhone: '0911', lines: [] }]);
  await pending;
  assert.equal(get('repair-print').children.length, 0);
  assert.equal(get('repair-list').children.length, 0);
});

test('staff can intake, quote, complete and mark full payment through repair RPCs', async () => {
  const nodes = new Map(), calls = [];
  function node(tag = 'div') { return { tag, value: '', textContent: '', hidden: false, disabled: false, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} },
    listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, append(...values) { this.children.push(...values); },
    replaceChildren(...values) { this.children = values; }, reset() {}, reportValidity: () => true }; }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  let state = { customers: [], salespeople: [{ id: 'sp-1', name: '甲業務', active: true }], items: [{ id: 'part-1', name: '煞車片', category: '零件', price: 120, stock: 5 }], serials: [] };
  let orders = [];
  let failCompletion = true;
  const browser = { print() {}, confirm: () => true, addEventListener() {}, AppAuthUI: { isActive: () => true }, AppData: {
    loadRepairOrders: async () => orders,
    async saveRepairOrder(order, lines, expected) {
      calls.push(['save', order.status, expected, 'salespersonId' in order, order.technicianId]);
      const current = orders[0];
      orders = [{ ...current, ...order, id: 'repair-1', number: 'R-1', updatedAt: String(calls.length),
        paymentStatus: 'unpaid', lines: lines.map((line, index) => ({ ...line, id: `line-${index}`, itemName: '煞車片', subtotal: line.quantity * line.unitPrice })) }];
      return { id: 'repair-1', orders, state };
    },
    async completeRepairOrder(id, serials) { calls.push(['complete', id, serials]); if (failCompletion) { failCompletion = false; throw new Error('庫存不足'); } orders = [{ ...orders[0], status: 'completed' }]; return { id, orders, state }; },
    async markRepairPaid(id) { calls.push(['pay', id]); orders = [{ ...orders[0], paymentStatus: 'paid' }]; return { id, orders, state }; },
  } };
  const document = { getElementById: get, createElement: node, body: { classList: { add() {}, remove() {} } } };
  vm.runInNewContext(source, { window: browser, document, Option: function Option(text, value) { return { text, value }; } });
  browser.RepairUI.mount({ getState: () => state, setState: next => { state = next; }, notify() {} });
  // 維修單不需要業務員：直接填客戶與車輛資料就能接修。
  for (const [id, value] of [['repair-customer-name', '臨時客'], ['repair-customer-phone', '0911'], ['repair-plate', 'ABC'], ['repair-vehicle', '車型'], ['repair-issue', '異音'], ['repair-labor', '50'], ['repair-item', 'part-1'], ['repair-quantity', '1'], ['repair-price', '120']]) get(id).value = value;
  get('repair-add-line').listeners.click();
  get('repair-form').listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  get('repair-quote').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  // 還沒指定維修人員：按完工不會送出。
  get('repair-detail').listeners.click({ target: { closest: () => ({ dataset: { repairAction: 'complete' } }) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call[0] === 'complete').length, 0);
  assert.match(get('repair-status').textContent, /請先在維修單指定維修人員/);
  get('repair-technician').value = 'tech-1';
  get('repair-quote').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  get('repair-detail').listeners.click({ target: { closest: () => ({ dataset: { repairAction: 'complete' } }) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(orders[0].status, 'quoted');
  assert.equal(get('repair-lines').children.length, 1);
  get('repair-detail').listeners.click({ target: { closest: () => ({ dataset: { repairAction: 'complete' } }) } });
  await new Promise(resolve => setImmediate(resolve));
  get('repair-detail').listeners.click({ target: { closest: () => ({ dataset: { repairAction: 'pay' } }) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call[0]), ['save', 'save', 'save', 'complete', 'complete', 'pay']);
  assert.deepEqual(calls.filter(call => call[0] === 'save').map(call => call[3]), [false, false, false], 'repair orders no longer send a salesperson');
  assert.deepEqual(calls.filter(call => call[0] === 'save').map(call => call[4]), [null, null, 'tech-1']);
  assert.equal(orders[0].paymentStatus, 'paid');
});

test('technician choices come from staff with the technician role only', () => {
  const nodes = new Map();
  function node(tag = 'div') { return { tag, value: '', textContent: '', hidden: false, disabled: false, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} },
    listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, append(...values) { this.children.push(...values); },
    replaceChildren(...values) { this.children = values; }, reset() {}, reportValidity: () => true }; }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const state = { customers: [], items: [], serials: [], salespeople: [
    { id: 'both', name: '全能', active: true, isSales: true, isTechnician: true },
    { id: 'sales', name: '純業務', active: true, isSales: true, isTechnician: false },
    { id: 'tech', name: '純維修', active: true, isSales: false, isTechnician: true },
    { id: 'gone', name: '離職維修', active: false, isSales: false, isTechnician: true },
  ] };
  const document = { getElementById: get, createElement: node, body: { dataset: {}, classList: { add() {}, remove() {} } } };
  const browser = { addEventListener() {}, AppAuthUI: { isActive: () => true }, AppData: {} };
  vm.runInNewContext(source, { window: browser, document, Option: function Option(text, value) { return { text, value }; } });
  browser.RepairUI.mount({ getState: () => state, setState() {}, notify() {} });
  assert.deepEqual(get('repair-technician').children.map(option => option.text), ['尚未指定', '全能', '純維修']);
});
