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

test('printing mode remembers the bluetooth option and printer offsets per device', () => {
  const storage = new Map();
  const L2 = load(storage);
  assert.equal(L2.mode(), 'print');
  L2.setMode('ble'); assert.equal(L2.mode(), 'ble');
  L2.setMode('nonsense'); assert.equal(L2.mode(), 'print');
  // 預設值：L58B 實測的左右 32、方向 1
  assert.deepEqual(plain(L2.printerSettings()), { x: 32, y: 0, direction: 1 });
  assert.deepEqual(plain(L2.savePrinterSettings({ x: 24, direction: 0 })), { x: 24, y: 0, direction: 0 });
  assert.deepEqual(plain(load(storage).printerSettings()), { x: 24, y: 0, direction: 0 });
  // 超出範圍或格式錯誤時回到預設
  storage.set('label-printer-settings-v1', JSON.stringify({ x: 500, y: 'a', direction: 7 }));
  assert.deepEqual(plain(load(storage).printerSettings()), { x: 32, y: 0, direction: 1 });
  storage.set('label-printer-settings-v1', '{壞掉');
  assert.deepEqual(plain(load(storage).printerSettings()), { x: 32, y: 0, direction: 1 });
});

test('direct printing connects once, reuses the connection and sends one TSPL job per label', async () => {
  const sent = [];
  let picks = 0, connected = true;
  const fakePrinter = { name: 'L58B', device: {}, isConnected: () => connected, send: async bytes => { sent.push(bytes); } };
  const LabelPrinter = {
    connectBluetooth: async () => { picks++; return fakePrinter; },
    openBluetooth: async () => { connected = true; return fakePrinter; },
    buildBitmapJob: (data, w, h, options) => ({ w, h, options }),
  };
  const ctx = { window: { LabelPrinter }, localStorage: { getItem: () => null, setItem() {} }, document: { getElementById: () => null } };
  vm.runInNewContext(source, ctx);
  const L3 = ctx.window.LabelImage;
  // 畫標籤需要瀏覽器的 canvas；這裡用 QR Code 與 canvas 的替身，只驗證連線與送出流程。
  ctx.window.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: () => false });
  ctx.document.createElement = () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {}, measureText: t => ({ width: t.length * 10 }), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, set fillStyle(v) {}, set font(v) {}, set textBaseline(v) {} }) });
  assert.equal(await L3.printDirect({ name: '煞車皮', sku: '3320261020001', barcode: '3320261020001' }), 'L58B');
  await L3.printDirect({ name: '後照鏡', sku: '4420261029001', barcode: '4420261029001' });
  assert.equal(picks, 1, '同一頁面只選一次標籤機');
  connected = false; // 標籤機關機再開：自動重連，不再跳出清單
  await L3.printDirect({ name: '手套', sku: '4420261029002', barcode: '4420261029002' });
  assert.equal(picks, 1);
  assert.equal(sent.length, 3);
  assert.deepEqual(plain(sent[0].options), { x: 32, y: 0, direction: 1 });
});
