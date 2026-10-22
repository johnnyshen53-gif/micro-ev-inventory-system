import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 官網商品：表單檢查、照片檔名、狀態，以及「先上傳照片 → 存設定 → 刪舊照片」的順序與失敗回復。
const source = await readFile(new URL('./website-items-ui.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const car = 'a0000000-0000-4000-8000-000000000031';

const pure = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(source, pure);
const UI = pure.window.WebsiteItemsUI;

test('blank numbers mean "not shown"; out-of-range numbers and long text are rejected', () => {
  assert.deepEqual(plain(UI.normalizeWeb(car, { visible: true, rangeKm: ' 45 ', topSpeed: '', batterySpec: ' 48V 24Ah ', summary: ' 好騎 ' })).value,
    { itemId: car, visible: true, rangeKm: 45, topSpeed: null, batterySpec: '48V 24Ah', summary: '好騎', photoPath: null });
  assert.match(UI.normalizeWeb(car, { topSpeed: '120' }).error, /最高時速/);
  assert.match(UI.normalizeWeb(car, { rangeKm: '0' }).error, /續航/);
  assert.match(UI.normalizeWeb(car, { rangeKm: '4.5' }).error, /續航/);
  assert.match(UI.normalizeWeb(car, { summary: '字'.repeat(301) }).error, /簡介/);
  assert.match(UI.normalizeWeb(car, { batterySpec: 'x'.repeat(61) }).error, /電池規格/);
  assert.equal(UI.normalizeWeb(car, { visible: 'yes' }).value.visible, false, 'only a real checkbox true counts');
});

test('photo names live under the item id and match the database path rule', () => {
  const rule = /^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,80}$/;
  for (const [mime, ext] of [['image/webp', 'webp'], ['image/jpeg', 'jpg'], ['image/png', 'png']]) {
    const path = UI.photoPath(car, 1730000000000, mime);
    assert.equal(path, `${car}/1730000000000.${ext}`);
    assert.match(path, rule);
  }
  assert.deepEqual(plain([undefined, { visible: true }, { visible: false }].map(UI.webStatus).map(s => s.label)), ['未設定', '顯示中', '未顯示']);
});

// ---- 極簡的假 DOM：只實作這個面板用到的屬性與事件 ----
function fakeDom() {
  const nodes = new Map();
  const make = id => {
    const listeners = {};
    const node = { id, value: '', checked: false, hidden: false, disabled: false, textContent: '', src: '', files: null, dataset: {}, children: [],
      classList: { toggle() {} },
      addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
      async fire(type, extra = {}) { for (const fn of listeners[type] ?? []) await fn({ preventDefault() {}, ...extra }); },
      replaceChildren(...kids) { node.children = kids; }, append(...kids) { node.children.push(...kids); },
      reset() { node.value = ''; }, focus() {}, scrollIntoView() {} };
    nodes.set(id, node);
    return node;
  };
  const ids = ['web-item-form', 'web-item-status', 'web-item-form-error', 'web-item-list', 'web-item-form-title', 'web-item-category-note', 'web-item-visible',
    'web-item-range', 'web-item-speed', 'web-item-battery', 'web-item-summary', 'web-item-summary-count', 'web-item-photo', 'web-item-photo-preview',
    'web-item-photo-remove', 'web-item-save', 'web-item-cancel'];
  ids.forEach(make);
  const document = {
    body: { dataset: { role: 'admin' } },
    getElementById: id => nodes.get(id) ?? null,
    createElement: tag => { const n = make(`${tag}-${Math.random()}`); n.tagName = tag; n.append = (...k) => n.children.push(...k); return n; },
  };
  return { document, nodes };
}

async function setup({ saveFails = false, existing = null } = {}) {
  const { document, nodes } = fakeDom();
  const calls = [];
  const AppData = {
    loadWebsiteItems: async () => existing ? [existing] : [],
    websitePhotoUrl: path => `https://cdn.example/${path}`,
    uploadWebsitePhoto: async path => { calls.push(['upload', path]); },
    saveItemWeb: async web => { calls.push(['save', web.photoPath]); if (saveFails) throw new Error('資料庫拒絕'); },
    deleteWebsitePhoto: async path => { calls.push(['delete', path]); },
  };
  const ctx = { window: { AppData }, document, URL: { createObjectURL: () => 'blob:preview', revokeObjectURL() {} }, Date: { now: () => 1730000000000 },
    createImageBitmap: async () => ({ width: 3200, height: 2400, close() {} }) };
  // 縮圖用的 canvas：回傳一個 WebP blob。
  const createElement = document.createElement;
  document.createElement = tag => tag === 'canvas'
    ? { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (cb, type) => cb({ type, size: 120000 }) }
    : createElement(tag);
  vm.runInNewContext(source, ctx);
  const ui = ctx.window.WebsiteItemsUI.mount({ getState: () => ({ items: [
    { id: car, name: '小粉微電車', category: '車身' }, { id: 'p1', name: '煞車拉桿', category: '機構元件' }] }) });
  await ui.load();
  return { ui, nodes, calls };
}
const openCar = async nodes => { const button = nodes.get('web-item-list').children[0].children[4].children[0]; await nodes.get('web-item-list').fire('click', { target: { closest: () => button } }); };

test('only 車身／電池 are listed, and a new photo is uploaded before saving', async () => {
  const { nodes, calls } = await setup({ existing: { itemId: car, visible: false, photoPath: `${car}/1700000000000.webp` } });
  assert.equal(nodes.get('web-item-list').children.length, 1, 'parts are not listed');
  await openCar(nodes);
  assert.equal(nodes.get('web-item-photo-preview').src, `https://cdn.example/${car}/1700000000000.webp`);
  nodes.get('web-item-visible').checked = true;
  nodes.get('web-item-photo').files = [{ type: 'image/jpeg' }];
  await nodes.get('web-item-photo').fire('change');
  await nodes.get('web-item-form').fire('submit');
  assert.deepEqual(calls, [['upload', `${car}/1730000000000.webp`], ['save', `${car}/1730000000000.webp`], ['delete', `${car}/1700000000000.webp`]]);
  assert.equal(nodes.get('web-item-form').hidden, true, 'form closes after saving');
});

test('when saving fails the just-uploaded photo is removed and the old photo is kept', async () => {
  const { nodes, calls } = await setup({ saveFails: true, existing: { itemId: car, visible: true, photoPath: `${car}/1700000000000.webp` } });
  await openCar(nodes);
  nodes.get('web-item-photo').files = [{ type: 'image/png' }];
  await nodes.get('web-item-photo').fire('change');
  await nodes.get('web-item-form').fire('submit');
  assert.deepEqual(calls, [['upload', `${car}/1730000000000.webp`], ['save', `${car}/1730000000000.webp`], ['delete', `${car}/1730000000000.webp`]]);
  assert.equal(nodes.get('web-item-form-error').textContent, '資料庫拒絕');
  assert.equal(nodes.get('web-item-form').hidden, false);
});

test('removing a photo saves without one, then deletes the old file', async () => {
  const { nodes, calls } = await setup({ existing: { itemId: car, visible: false, photoPath: `${car}/1700000000000.webp` } });
  await openCar(nodes);
  await nodes.get('web-item-photo-remove').fire('click');
  await nodes.get('web-item-form').fire('submit');
  assert.deepEqual(calls, [['save', null], ['delete', `${car}/1700000000000.webp`]]);
});
