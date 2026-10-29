import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// 低庫存提示：依分類列按鈕，點分類才展開清單；最近異動只列最新 5 筆。
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const block = app.slice(app.indexOf('// 低庫存提示：'), app.indexOf('// 品項庫存依分類檢視'));
const summary = app.match(/function renderSummary\(\) \{[\s\S]*?\n\}/)[0];

function harness(items, transactions = []) {
  const nodes = new Map();
  const node = () => ({ value: '', textContent: '', className: '', hidden: false, dataset: {}, children: [], attributes: {}, listeners: {},
    replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); },
    setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(t, fn) { this.listeners[t] = fn; } });
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const context = { $, state: { items, transactions }, document: { createElement: node }, formatNumber: String, inventoryCost: () => 0,
    itemName: id => id, appendEmpty: (list, text) => { const li = node(); li.textContent = text; list.append(li); } };
  vm.createContext(context);
  vm.runInContext("const ITEM_CATEGORIES = ['車身', '電池', '電控元件', '機構元件', '外觀元件'];\n" + block + '\n' + summary, context);
  const click = category => $('low-stock-tabs').listeners.click({ target: { closest: () => ({ dataset: { lowCategory: category } }) } });
  return { $, context, click };
}
const item = (name, category, stock, minimumStock = 1) => ({ id: name, name, category, stock, minimumStock });

test('low stock is grouped by category and the list opens only after a category is clicked', () => {
  const { $, context, click } = harness([item('電池A', '電池', 0), item('電池B', '電池', 1), item('煞車皮', '機構元件', 0), item('後照鏡', '外觀元件', 5)]);
  context.renderSummary();
  assert.deepEqual($('low-stock-tabs').children.map(b => b.textContent), ['電池（2）', '機構元件（1）']);
  assert.equal($('low-stock-list').hidden, true);
  assert.match($('low-stock-hint').textContent, /點分類/);
  click('電池');
  assert.equal($('low-stock-list').hidden, false);
  assert.deepEqual($('low-stock-list').children.map(li => li.textContent), ['電池A：剩 0（最低 1）', '電池B：剩 1（最低 1）']);
  assert.equal($('low-stock-tabs').children[0].attributes['aria-pressed'], 'true');
  click('電池'); // 再點一次收合
  assert.equal($('low-stock-list').hidden, true);
});

test('no low stock shows a message and recent changes list only the newest five', () => {
  const transactions = Array.from({ length: 8 }, (_, i) => ({ itemId: `品${i}`, type: 'in', quantity: 1, createdAt: `2026-10-0${i + 1}T00:00:00Z` }));
  const { $, context } = harness([item('後照鏡', '外觀元件', 5)], transactions);
  context.renderSummary();
  assert.equal($('low-stock-tabs').children.length, 0);
  assert.match($('low-stock-hint').textContent, /目前沒有低庫存/);
  const recent = $('recent-transactions').children.map(li => li.textContent);
  assert.equal(recent.length, 5);
  assert.match(recent[0], /^品7/);
});
