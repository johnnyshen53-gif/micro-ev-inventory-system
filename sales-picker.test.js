import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const inventoryContext = { window: {} };
vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), inventoryContext);
function fixture() {
  const nodes = new Map();
  const node = () => ({ value: '', children: [], dataset: {}, listeners: {}, replaceChildren() { this.children = []; this.value = ''; }, append(child) { this.children.push(child); }, addEventListener(type, fn) { this.listeners[type] = fn; }, focus() {} });
  const $ = id => { if (!nodes.has(id)) { const element = node(); Object.defineProperty(element, 'options', { get() { return this.children; } }); Object.defineProperty(element, 'selectedOptions', { get() { return this.children.filter(option => option.selected); } }); nodes.set(id, element); } return nodes.get(id); };
  const context = { $, document: { createElement: node }, formatNumber: String, showFormError: (_, message) => { context.error = message; }, clearFormError() {}, state: { items: [{ id: 'a', category: '電控元件', name: '煞車皮', price: 350, cost: 180, stock: 2, barcode: '123' }, { id: 'b', category: '機構元件', name: '安全帽', price: 900, stock: 0, barcode: '' }] }, saleCart: [] };
  vm.createContext(context);
  context.requiresSerial = inventoryContext.window.Inventory.requiresSerial;
  context.state.serials = [];
  context.saleSerialItemId = ''; context.saleSerialQuantity = 1;
  vm.runInContext(app.slice(app.indexOf('function parseUnitQr('), app.indexOf("$('item-search')?.addEventListener('input', renderItems);")), context);
  vm.runInContext(app.slice(app.indexOf('function renderSalePicker()'), app.indexOf("if ($('sale-form'))")), context);
  return context;
}
test('category picker filters products, clears stale selections and disables missing stock', () => {
  const c = fixture();
  c.$('sale-category').value = '電控元件'; c.renderSalePicker();
  assert.equal(c.$('sale-item').children.length, 2);
  assert.match(c.$('sale-item').children[1].textContent, /煞車皮.*350.*2/);
  c.$('sale-item').value = 'a'; c.renderSalePicker();
  assert.equal(c.$('sale-pick-add').disabled, false);
  c.$('sale-category').value = '機構元件'; c.renderSalePicker();
  assert.equal(c.$('sale-item').value, '');
  assert.equal(c.$('sale-item').children[1].disabled, true);
  assert.equal(c.$('sale-pick-add').disabled, true);
  c.$('sale-category').value = '電池'; c.renderSalePicker();
  assert.match(c.$('sale-picker-hint').textContent, /尚無/);
});
test('selected and scanned products share a cart with stock and quantity validation', () => {
  const c = fixture();
  c.$('sale-category').value = '電控元件'; c.$('sale-item').value = 'a'; c.$('sale-pick-quantity').value = '1';
  c.$('sale-pick-add').listeners.click();
  c.$('sale-barcode').value = '123'; c.$('sale-quantity').value = '1'; c.addSaleLine();
  assert.equal(c.saleCart.length, 1); assert.equal(c.saleCart[0].quantity, 2);
  assert.equal(c.saleCart[0].itemId, 'a');
  assert.equal(c.state.items[0].stock, 2);
  assert.equal(c.addSaleItem(c.state.items[0], 1), false);
  assert.match(c.error, /庫存不足/);
  assert.equal(c.addSaleItem(c.state.items[0], 0), false);
  assert.equal(c.saleCart[0].quantity, 2);
  c.$('sale-cart').listeners.click({ target: { closest: () => ({ dataset: { saleRemove: '0' } }) } });
  assert.equal(c.saleCart.length, 0);
  assert.equal(c.$('sale-item').children[1].disabled, false);
});

test('picker has labelled native controls without requiring a selection for checkout', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  for (const id of ['sale-category', 'sale-item', 'sale-pick-quantity']) {
    assert.match(html, new RegExp(`label for="${id}"`));
    const control = html.match(new RegExp(`<(?:select|input)[^>]*id="${id}"[^>]*>`))[0];
    assert.doesNotMatch(control, /required/);
  }
  assert.match(html, /id="sale-pick-add" type="button"/);
  assert.match(html, /id="sale-picker-hint"[^>]*aria-live="polite"/);
});
test('scanning serialized products requires distinct available units before adding', () => {
  const c = fixture();
  c.state.items[0].category = '電池';
  c.state.serials = [{ id: 's1', itemId: 'a', serialNumber: '000A', status: 'in_stock' }, { id: 's2', itemId: 'a', serialNumber: 'B', status: 'in_stock' }];
  c.$('sale-barcode').value = '123'; c.$('sale-quantity').value = '1';
  c.addSaleLine();
  assert.equal(c.saleCart.length, 0); assert.equal(c.saleSerialItemId, 'a');
  assert.equal(c.addSaleItem(c.state.items[0], 1), false);
  assert.equal(c.addSaleItem(c.state.items[0], 1, ['s1']), true);
  assert.equal(c.saleCart[0].serialNumbers[0], '000A');
  // 序號顯示在品名下方的小字（品名儲存格的子元素）。
  const nameCell = c.$('sale-cart').children[0].children[0];
  assert.match([nameCell.textContent, ...Array.from(nameCell.children ?? [], child => child.textContent)].join(''), /000A/);
  assert.equal(c.addSaleItem(c.state.items[0], 1, ['s1']), false);
  assert.equal(c.addSaleItem(c.state.items[0], 1, ['s2']), true);
  assert.equal(c.saleCart[0].quantity, 2);
  c.$('sale-cart').listeners.click({ target: { closest: () => ({ dataset: { saleRemove: '0' } }) } });
  assert.equal(c.$('sale-serial-ids').children.length, 2);
  c.state.serials.pop();
  assert.equal(c.addSaleItem(c.state.items[0], 1, ['s1']), false);
});

test('batteries and parts must pick a vehicle model first; the list shows that model, universal and unset items', () => {
  const c = fixture();
  c.state.vehicleModels = [
    { id: 'vm-all', name: '通用', isUniversal: true, active: true },
    { id: 'vm-a', name: '小偉士', isUniversal: false, active: true },
    { id: 'vm-b', name: 'Vespa', isUniversal: false, active: true },
    { id: 'vm-old', name: '舊款', isUniversal: false, active: false },
  ];
  c.state.items = [
    { id: 'u', category: '電控元件', name: '通用保險絲', price: 50, stock: 5, vehicleModelId: 'vm-all' },
    { id: 'a', category: '電控元件', name: '小偉士控制器', price: 2000, stock: 1, vehicleModelId: 'vm-a' },
    { id: 'b', category: '電控元件', name: 'Vespa 控制器', price: 2500, stock: 1, vehicleModelId: 'vm-b' },
    { id: 'n', category: '電控元件', name: '舊煞車線', price: 80, stock: 2, vehicleModelId: '' },
    { id: 'o', category: '電控元件', name: '舊款燈', price: 90, stock: 2, vehicleModelId: 'vm-old' },
    { id: 'car', category: '車身', name: '小偉士', price: 39800, stock: 1, vehicleModelId: 'vm-a' },
  ];
  // 車身不用選車種
  c.$('sale-category').value = '車身'; c.renderSalePicker();
  assert.equal(c.$('sale-vehicle-model-field').hidden, true);
  assert.equal(c.$('sale-item').children.length, 2);
  // 元件：先選車種，否則沒有品項可選
  c.$('sale-category').value = '電控元件'; c.renderSalePicker();
  assert.equal(c.$('sale-vehicle-model-field').hidden, false);
  assert.deepEqual(c.$('sale-vehicle-model').children.map(option => option.textContent), ['請選擇車種', '通用', '小偉士', '舊款（已停用）', 'Vespa']);
  assert.equal(c.$('sale-item').children.length, 1);
  assert.equal(c.$('sale-item').children[0].textContent, '請先選擇車種');
  assert.equal(c.$('sale-item').disabled, true);
  assert.match(c.$('sale-picker-hint').textContent, /請先選車種/);
  // 選小偉士：小偉士 → 通用 → 未設定，不含 Vespa 與舊款
  c.$('sale-vehicle-model').value = 'vm-a'; c.renderSalePicker();
  assert.deepEqual(c.$('sale-item').children.slice(1).map(option => option.value), ['a', 'u', 'n']);
  assert.match(c.$('sale-item').children[2].textContent, /通用保險絲（通用）/);
  assert.match(c.$('sale-item').children[3].textContent, /舊煞車線（未設定車種）/);
  // 換分類時保留車種
  c.$('sale-category').value = '機構元件'; c.renderSalePicker();
  assert.equal(c.$('sale-vehicle-model').value, 'vm-a');
  assert.match(c.$('sale-picker-hint').textContent, /這個車種在此分類沒有品項/);
  // 停用車種只有在此分類還有品項時才出現
  assert.equal(c.$('sale-vehicle-model').children.some(option => option.value === 'vm-old'), false);
});
