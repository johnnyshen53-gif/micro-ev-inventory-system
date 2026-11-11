// 庫存清單的供應商篩選：分類按鈕旁的下拉選單，只有店長看得到；和分類、搜尋可以同時使用，分類按鈕的數字跟著變。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const start = app.indexOf('// 品項庫存依分類檢視');
const renderItems = app.match(/function renderItems\(\) \{[\s\S]*?\n\}/)[0];
const listeners = ['item-category-tabs', 'item-supplier-filter', 'item-model-filter'].map(id => app.match(new RegExp(`\\$\\('${id}'\\)\\?\\.addEventListener\\('(click|change)'[\\s\\S]*?\\n\\}\\);`))[0]).join('\n');

function harness(role) {
  const nodes = new Map();
  const node = () => ({ value: '', textContent: '', className: '', hidden: false, dataset: {}, children: [], attributes: {}, listeners: {},
    replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); },
    setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(t, fn) { this.listeners[t] = fn; } });
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const item = (name, category, supplierId, vehicleModelId = 'm0') => ({ id: name, name, category, sku: '', barcode: '', price: 1, stock: 1, minimumStock: 0, supplierId, vehicleModelId });
  const state = {
    suppliers: [{ id: 's1', name: '美家園', active: true }, { id: 's2', name: '林晟', active: true }, { id: 's3', name: '沒有品項的廠商', active: true }],
    vehicleModels: [{ id: 'm0', name: '通用', isUniversal: true, active: true }, { id: 'm1', name: 'JY-188', active: true }, { id: 'm2', name: 'KIKO', active: true }],
    items: [item('座墊', '外觀元件', 's1', 'm1'), item('後架', '機構元件', 's1', 'm1'), item('前土除', '外觀元件', 's1'), item('控制器', '電控元件', 's2', 'm2'), item('螺絲', '機構元件', '')],
  };
  const context = { $, state, Option: function (text, value) { return { text, value }; }, document: { createElement: node, body: { dataset: { role } } },
    formatNumber: String, supplierName: () => '—', vehicleModelLabel: () => '通用', priceTierChoices: () => [], formatPriceTime: () => '' };
  vm.createContext(context);
  vm.runInContext(app.slice(start, app.indexOf('function renderItems() {')) + renderItems + '\n' + listeners, context);
  const names = () => $('item-list').children.map(row => row.children[0].textContent);
  const tabs = () => $('item-category-tabs').children.map(tab => tab.textContent);
  const choose = (value, id = 'item-supplier-filter') => { $(id).value = value; $(id).listeners.change({ target: { value } }); };
  const click = category => $('item-category-tabs').listeners.click({ target: { closest: () => ({ dataset: { category } }) } });
  return { $, context, names, tabs, choose, click };
}

test('the manager can filter the list by supplier; category counts follow the supplier', () => {
  const { $, context, names, tabs, choose, click } = harness('admin');
  context.renderItems();
  assert.equal($('item-supplier-filter-field').hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify($('item-supplier-filter').children)), [
    { text: '全部供應商（5）', value: '' }, { text: '美家園（3）', value: 's1' }, { text: '林晟（1）', value: 's2' }, { text: '未指定供應商（1）', value: '__none__' },
  ], '沒有品項的廠商不列出；品項多的在前');
  choose('s1');
  assert.deepEqual(names(), ['座墊', '後架', '前土除']);
  assert.deepEqual(tabs(), ['全部（3）', '車身（0）', '電池（0）', '電控元件（0）', '機構元件（1）', '外觀元件（2）']);
  click('外觀元件');
  assert.deepEqual(names(), ['座墊', '前土除'], '分類和供應商一起篩選');
  click('電控元件');
  assert.equal(names()[0], '「電控元件」分類在目前篩選條件下沒有品項。');
  click(''); choose('__none__');
  assert.deepEqual(names(), ['螺絲']);
  choose('');
  assert.deepEqual(names(), ['請先選擇供應商或車種，或在搜尋框輸入品名、料號。'], '全部清掉就回到先不列的狀態');
  $('item-search').value = '控制'; context.renderItems();
  assert.deepEqual(names(), ['控制器'], '沒選篩選也可以直接搜尋');
});

test('clerks do not see the supplier filter (they cannot see suppliers)', () => {
  const { $, context, names } = harness('clerk');
  context.renderItems();
  assert.equal($('item-supplier-filter-field').hidden, true);
  assert.deepEqual(names(), ['請先選擇車種，或在搜尋框輸入品名、料號。']);
});

test('the supplier and vehicle filters sit on a row above the category tabs', () => {
  // 第一列是供應商、車種下拉選單，第二列是分類按鈕。
  assert.match(html, /<div class="item-filters"><div class="item-filter-selects"><label id="item-supplier-filter-field" class="supplier-filter" hidden><span>供應商<\/span><select id="item-supplier-filter">.*?<\/label><label class="supplier-filter"><span>車種<\/span><select id="item-model-filter">.*?<\/label><\/div><div id="item-category-tabs" class="category-tabs" aria-label="依分類檢視"><\/div><\/div>/);
});

test('everyone can filter by vehicle model; the two dropdowns narrow each other', () => {
  const { $, context, names, tabs, choose } = harness('clerk');
  context.renderItems();
  const options = id => JSON.parse(JSON.stringify($(id).children));
  assert.deepEqual(options('item-model-filter'), [
    { text: '全部車種（5）', value: '' }, { text: '通用（2）', value: 'm0' }, { text: 'JY-188（2）', value: 'm1' }, { text: 'KIKO（1）', value: 'm2' },
  ], '「通用」排第一，其餘品項多的在前');
  choose('m1', 'item-model-filter');
  assert.deepEqual(names(), ['座墊', '後架']);
  assert.deepEqual(tabs(), ['全部（2）', '車身（0）', '電池（0）', '電控元件（0）', '機構元件（1）', '外觀元件（1）']);

  const admin = harness('admin');
  admin.context.renderItems();
  admin.choose('s1');
  assert.deepEqual(JSON.parse(JSON.stringify(admin.$('item-model-filter').children)).map(o => o.text), ['全部車種（3）', '通用（1）', 'JY-188（2）'], '選了供應商，車種選單只算那家');
  admin.choose('m1', 'item-model-filter');
  assert.deepEqual(admin.names(), ['座墊', '後架']);
  assert.deepEqual(JSON.parse(JSON.stringify(admin.$('item-supplier-filter').children)).map(o => o.text), ['全部供應商（2）', '美家園（2）'], '選了車種，供應商選單只算那個車種');
  // 換一家沒有這個車種的供應商：車種仍保留（顯示 0），清單顯示沒有品項。
  admin.choose('s2');
  assert.equal(admin.$('item-model-filter').value, 'm1');
  assert.equal(admin.names()[0], '目前篩選條件下沒有品項。');
});
