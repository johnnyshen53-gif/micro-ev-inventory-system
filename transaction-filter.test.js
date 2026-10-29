import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// 登記庫存異動：品項可依分類、車種篩選（車種：該車種＋通用＋未設定車種，和銷售頁相同）。
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const render = app.match(/function renderTransactionItems\(\) \{[\s\S]*?\n\}/)[0];

function harness() {
  const nodes = new Map();
  const node = () => ({ value: '', textContent: '', hidden: false, disabled: false, children: [],
    get options() { return this.children; }, replaceChildren(...c) { this.children = c; this.value = c[0]?.value ?? ''; }, append(...c) { this.children.push(...c); },
    querySelector() { return $('submit-button'); } });
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const state = {
    vehicleModels: [
      { id: 'all', name: '通用', isUniversal: true, active: true },
      { id: 'a', name: '小偉士', isUniversal: false, active: true },
      { id: 'b', name: 'Vespa', isUniversal: false, active: true },
    ],
    items: [
      { id: 'car', name: '小偉士車身', category: '車身', stock: 1, vehicleModelId: 'a' },
      { id: 'pa', name: '小偉士煞車', category: '機構元件', stock: 3, vehicleModelId: 'a' },
      { id: 'pb', name: 'Vespa 煞車', category: '機構元件', stock: 2, vehicleModelId: 'b' },
      { id: 'pu', name: '通用螺絲', category: '機構元件', stock: 9, vehicleModelId: 'all' },
      { id: 'pn', name: '舊煞車線', category: '機構元件', stock: 1, vehicleModelId: '' },
    ],
  };
  const context = { $, state, formatNumber: String, Option: function Option(text, value) { this.textContent = text; this.value = value; } };
  vm.createContext(context);
  vm.runInContext(render, context);
  return { $, context };
}
const ids = select => select.children.map(option => option.value);

test('category and vehicle model narrow the item list for stock changes', () => {
  const { $, context } = harness();
  context.renderTransactionItems();
  assert.deepEqual(ids($('transaction-item')), ['car', 'pa', 'pb', 'pu', 'pn'], '預設全部');
  $('transaction-category').value = '車身'; context.renderTransactionItems();
  assert.deepEqual(ids($('transaction-item')), ['car']);
  assert.equal($('transaction-vehicle-model-field').hidden, true, '車身不選車種');
  $('transaction-category').value = '機構元件'; context.renderTransactionItems();
  assert.equal($('transaction-vehicle-model-field').hidden, false);
  assert.deepEqual(ids($('transaction-item')), ['pa', 'pb', 'pu', 'pn']);
  $('transaction-vehicle-model').value = 'a'; context.renderTransactionItems();
  assert.deepEqual(ids($('transaction-item')), ['pa', 'pu', 'pn']);
  assert.match($('transaction-item').children[1].textContent, /通用螺絲（通用）/);
  assert.match($('transaction-item').children[2].textContent, /舊煞車線（未設定車種）/);
  $('transaction-category').value = '電池'; context.renderTransactionItems();
  assert.equal($('transaction-item').children[0].textContent, '此條件沒有品項');
  assert.equal($('submit-button').disabled, true);
});
