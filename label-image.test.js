import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 標籤圖片（藍牙標籤機用）：文字換行、QR 內容、檔名與列印方式的記憶。
const source = await readFile(new URL('./label-image.js', import.meta.url), 'utf8');
function load(storage = new Map()) {
  const localStorage = { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)) };
  const ctx = { window: {}, localStorage, document: { getElementById: () => null } };
  vm.runInNewContext(source, ctx);
  return ctx.window.LabelImage;
}
const L = load();
const plain = v => JSON.parse(JSON.stringify(v));
const measure = text => Array.from(text).length * 10; // 每個字 10 像素寬

test('label is 40×30 mm at 8 dots per mm (320×240 px)', () => {
  assert.equal(L.WIDTH_MM * L.DOTS_PER_MM, 320);
  assert.equal(L.HEIGHT_MM * L.DOTS_PER_MM, 240);
});

test('names wrap to the width and long ones end with an ellipsis', () => {
  assert.deepEqual(plain(L.wrapText('48V 鋰電池', 200, 2, measure)), ['48V 鋰電池']);
  assert.deepEqual(plain(L.wrapText('一二三四五六七八', 40, 2, measure)), ['一二三四', '五六七八']);
  const cut = L.wrapText('一二三四五六七八九十', 40, 2, measure);
  assert.equal(cut.length, 2);
  assert.ok(cut[1].endsWith('…'));
  assert.ok(cut.every(line => measure(line) <= 40));
  assert.deepEqual(plain(L.wrapText('', 40, 2, measure)), []);
});

test('QR content matches the scanner format used at checkout', () => {
  assert.equal(L.qrPayload({ barcode: '1120261022001' }), '1120261022001');
  assert.equal(L.qrPayload({ barcode: '8826482401003', serialNumber: 'LB24A0012345' }), '8826482401003|LB24A0012345');
});

test('file names are safe and include the serial when there is one', () => {
  assert.equal(L.fileName({ sku: '1120261022001', barcode: '1120261022001' }), '標籤_1120261022001.png');
  assert.equal(L.fileName({ sku: '88/26', serialNumber: 'A B?1' }), '標籤_8826_AB1.png');
});

test('print mode defaults to the browser and is remembered per device', () => {
  const store = new Map();
  const first = load(store);
  assert.equal(first.mode(), 'print');
  first.setMode('image');
  assert.equal(load(store).mode(), 'image');
  first.setMode('anything-else');
  assert.equal(load(store).mode(), 'print');
});
