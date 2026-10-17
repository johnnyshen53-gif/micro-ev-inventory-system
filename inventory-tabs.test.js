import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// 只載入「分類按鈕＋品項表」這段程式，用簡化的 DOM 替身驗證。
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const start = app.indexOf('// 品項庫存依分類檢視');
const renderItems = app.match(/function renderItems\(\) \{[\s\S]*?\n\}/)[0];
const tabsListener = app.match(/\$\('item-category-tabs'\)\?\.addEventListener\('click'[\s\S]*?\n\}\);/)[0];

function harness(items) {
  const nodes = new Map();
  const node = () => ({ value: '', textContent: '', className: '', dataset: {}, children: [], attributes: {}, listeners: {},
    replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); },
    setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(t, fn) { this.listeners[t] = fn; } });
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const context = { $, state: { items }, document: { createElement: node, body: { dataset: { role: 'clerk' } } }, formatNumber: String, supplierName: () => '—' };
  vm.createContext(context);
  vm.runInContext(app.slice(start, app.indexOf('function renderItems() {')) + renderItems + '\n' + tabsListener, context);
  const click = category => $('item-category-tabs').listeners.click({ target: { closest: () => ({ dataset: { category } }) } });
  return { $, context, click };
}
const item = (name, category, stock, minimumStock = 1) => ({ id: name, name, category, sku: '', barcode: '', price: 1, stock, minimumStock, supplierId: '' });

test('inventory list can be viewed by category with counts and low-stock badges', () => {
  const { $, context, click } = harness([item('EV-200', '機車', 3), item('煞車皮', '零件', 0), item('機油', '零件', 9), item('安全帽', '用品', 5)]);
  context.renderItems();
  const tabs = $('item-category-tabs').children;
  assert.deepEqual(tabs.map(t => t.textContent), ['全部（4）', '機車（1）', '零件（2）', '用品（1）', '電池（0）']);
  assert.equal(tabs[0].attributes['aria-pressed'], 'true');
  assert.equal(tabs[2].children[0].textContent, '低庫存 1');
  assert.equal($('item-list').children.length, 4);

  click('零件');
  assert.deepEqual($('item-list').children.map(row => row.children[0].textContent), ['煞車皮', '機油']);
  assert.equal($('item-category-tabs').children[2].attributes['aria-pressed'], 'true');

  // 搜尋只在目前分類內進行。
  $('item-search').value = '機油'; context.renderItems();
  assert.deepEqual($('item-list').children.map(row => row.children[0].textContent), ['機油']);

  $('item-search').value = ''; click('電池');
  assert.equal($('item-list').children[0].children[0].textContent, '「電池」分類目前沒有品項。');
  click('');
  assert.equal($('item-list').children.length, 4);
});
