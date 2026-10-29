import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 藍牙標籤機 TSPL 指令：點陣格式要和原廠 SDK 相同（黑＝0、白＝1，左邊的點在高位元）。
const context = { window: {}, TextEncoder, navigator: {}, setTimeout };
vm.createContext(context);
vm.runInContext(await readFile(new URL('./label-printer.js', import.meta.url), 'utf8'), context);
const { LabelPrinter } = context.window;
const decode = bytes => new TextDecoder('latin1').decode(bytes);
// 產生 RGBA：每列一個字串，# 代表黑點。
function rgba(rows) {
  const width = rows[0].length, data = new Uint8ClampedArray(width * rows.length * 4);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { const v = ch === '#' ? 0 : 255; data.set([v, v, v, 255], (y * width + x) * 4); }));
  return { data, width, height: rows.length };
}

test('bitmap bytes: black is 0, white is 1, leftmost dot is the high bit', () => {
  const img = rgba(['#.......########', '........#.......']);
  assert.deepEqual([...LabelPrinter.toBitmapBytes(img.data, img.width, img.height)], [0b01111111, 0b00000000, 0b11111111, 0b01111111]);
  assert.deepEqual([...LabelPrinter.toBitmapBytes(img.data, img.width, img.height, { invert: true })], [0b10000000, 0b11111111, 0b00000000, 0b10000000]);
  assert.throws(() => LabelPrinter.toBitmapBytes(new Uint8ClampedArray(12 * 4), 12, 1), /8 的倍數/);
});

test('bitmap job wraps the dots with size, gap, direction, clear and print commands', () => {
  const img = rgba(['########', '........']);
  const job = LabelPrinter.buildBitmapJob(img.data, img.width, img.height, { direction: 0, gapMm: 3, x: 32, y: 4, density: 10 });
  const text = decode(job);
  assert.match(text, /^SIZE 40 mm,30 mm\r\nGAP 3 mm,0 mm\r\nDIRECTION 0\r\nREFERENCE 0,0\r\nDENSITY 10\r\nCLS\r\nBITMAP 32,4,1,2,0,/);
  const start = text.indexOf('BITMAP 32,4,1,2,0,') + 'BITMAP 32,4,1,2,0,'.length;
  assert.deepEqual([...job.slice(start, start + 2)], [0x00, 0xff]);
  assert.ok(text.endsWith('\r\nPRINT 1,1\r\n'));
  assert.doesNotMatch(decode(LabelPrinter.buildBitmapJob(img.data, 8, 2)), /DENSITY/);
  assert.match(decode(LabelPrinter.buildTextJob()), /SIZE 40 mm,30 mm[\s\S]*BOX[\s\S]*QRCODE[\s\S]*PRINT 1,1/);
  assert.doesNotMatch(Object.keys(LabelPrinter).join(','), /CALIBRATE/, 'L58B 收到 GAPDETECT 會卡住，不提供校正');
});

test('bluetooth sends the job in small chunks through the first writable channel', async () => {
  const written = [];
  const writer = { uuid: 'ff02', properties: { writeWithoutResponse: true }, writeValueWithoutResponse: async part => { written.push(part.length); } };
  const device = { name: 'L58B', gatt: { connected: true, connect: async () => ({ disconnect() {}, getPrimaryServices: async () => [
    { uuid: '180a', getCharacteristics: async () => [{ uuid: '2a25', properties: { read: true } }] },
    { uuid: 'ff00', getCharacteristics: async () => [writer] },
  ] }), disconnect() {} } };
  const printer = await LabelPrinter.openBluetooth(device);
  assert.match(printer.info, /使用：ff02/);
  await printer.send(new Uint8Array(400));
  assert.deepEqual(written, [180, 180, 40]);
  assert.equal(printer.isConnected(), true);
});
