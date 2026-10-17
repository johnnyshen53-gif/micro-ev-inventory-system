import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('./bonus-ui.js', import.meta.url), 'utf8');

function fakeDom(role) {
  const nodes = new Map();
  function node(tag = 'div') {
    return { tag, id: '', value: '', textContent: '', hidden: false, checked: false, type: '', dataset: {}, children: [],
      classList: { toggle() {} }, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; },
      append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; },
      querySelectorAll() { return this.children.flatMap(child => child.children ?? []).filter(child => child.type === 'checkbox'); } };
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const document = { getElementById: get, createElement: node, createTextNode: text => ({ text }), body: { dataset: role ? { role } : {} } };
  return { get, document };
}

test('bonus page is a manager-only tab with its own script', () => {
  assert.match(html, /data-page-target="bonus" data-role="admin"/);
  assert.match(html, /data-page="bonus"[^>]*data-role="admin"/);
  assert.match(html, /<script src="bonus-ui\.js\?v=\d+"><\/script>/);
});

test('setting labels distinguish "not set" from an explicit zero', () => {
  const context = { window: {}, document: fakeDom().document };
  vm.runInNewContext(source, context);
  const { settingLabel, parseSetting, summarize } = context.window.BonusUI;
  assert.match(settingLabel(null, 'amount'), /未設定/);
  assert.match(settingLabel(0, 'percent'), /明確不發/);
  assert.match(settingLabel(10, 'percent'), /10%/);
  assert.equal(parseSetting('', 'amount'), null);
  assert.equal(parseSetting('0', 'amount'), 0);
  assert.throws(() => parseSetting('101', 'percent'), /不可超過 100/);
  assert.throws(() => parseSetting('-1', 'amount'), /0 以上/);
  const totals = summarize([
    { kind: 'motorcycle', personId: 'a', personName: '甲', bonusAmount: 500 },
    { kind: 'motorcycle', personId: 'a', personName: '甲', bonusAmount: 500.1 },
    { kind: 'repair', personId: 't', personName: '維修甲', bonusAmount: 34 },
  ]);
  assert.equal(totals[0].bonusAmount, 1000.1);
  assert.equal(totals[0].count, 2);
});

test('staff never load bonus data; manager saves the checked recipients and items', async () => {
  for (const role of ['clerk', 'admin']) {
    const { get, document } = fakeDom(role);
    const calls = [];
    const AppData = {
      loadBonusAdminState: async () => { calls.push('state'); return { motorcycleBonusAmount: null, repairBonusPercent: 10, recipientIds: [], motorcycleItemIds: [], partCosts: [], technicians: [] }; },
      loadMonthlyBonusReport: async () => { calls.push('report'); return []; },
      saveBonusSettings: async settings => { calls.push(['save', settings]); },
    };
    const context = { window: { AppData }, document };
    vm.runInNewContext(source, context);
    // 純維修（isSales: false）不會出現在機車獎金受領名單。
    const state = { salespeople: [{ id: 'sp-1', name: '甲業務', active: true }, { id: 'tech-1', name: '純維修', active: true, isSales: false, isTechnician: true }], items: [{ id: 'moto-1', name: '電動機車', category: '機車' }, { id: 'part-1', name: '煞車片', category: '零件' }] };
    const ui = context.window.BonusUI.mount({ getState: () => state });
    await ui.load();
    if (role === 'clerk') { assert.deepEqual(calls, []); continue; }
    assert.match(get('bonus-motorcycle-state').textContent, /未設定/);
    assert.equal(get('bonus-items').children.length, 1, 'only motorcycle-category items are listed by default');
    assert.equal(get('bonus-recipients').children.length, 1, 'technician-only staff are not bonus recipients');
    for (const list of ['bonus-recipients', 'bonus-items']) get(list).children[0].children[0].checked = true;
    get('bonus-motorcycle-amount').value = '500';
    get('bonus-repair-percent').value = '';
    get('bonus-settings-form').listeners.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    const save = calls.find(call => call[0] === 'save');
    assert.deepEqual(JSON.parse(JSON.stringify(save[1])), { motorcycleBonusAmount: 500, repairBonusPercent: null, recipientIds: ['sp-1'], motorcycleItemIds: ['moto-1'] });
  }
});
