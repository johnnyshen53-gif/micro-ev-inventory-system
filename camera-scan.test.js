// 相機掃描：不支援時按鈕隱藏；支援時開相機 → 辨識到 QR Code → 關相機並把內容交給原本的掃描處理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./camera-scan.js', import.meta.url), 'utf8');

function fakeElement(tag) {
  const el = { tag, children: [], attrs: {}, listeners: {}, hidden: false, open: false,
    setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    querySelector(sel) { return this.children.find(c => c.tag === sel); },
    showModal() { this.open = true; }, close() { this.open = false; }, play: async () => {} };
  return el;
}

function load({ detector = true, camera = true, cameraError = null, codes = [{ rawValue: '4710000000017' }] } = {}) {
  const stopped = [];
  const navigator = { vibrate() {} };
  if (camera) navigator.mediaDevices = { getUserMedia: async () => { if (cameraError) throw cameraError; return { getTracks: () => [{ stop: () => stopped.push(1) }] }; } };
  const window = {};
  if (detector) window.BarcodeDetector = class { static async getSupportedFormats() { return ['qr_code', 'ean_13']; } async detect() { return codes; } };
  const document = { body: fakeElement('body'), createElement: fakeElement };
  const ctx = { window, navigator, document, setInterval, clearInterval };
  vm.runInNewContext(source, ctx);
  return { CameraScan: window.CameraScan, document, stopped };
}

test('unsupported browsers keep the camera button hidden', () => {
  for (const opts of [{ detector: false }, { camera: false }]) {
    const { CameraScan } = load(opts);
    const button = fakeElement('button');
    CameraScan.mount(button, () => {});
    assert.equal(button.hidden, true);
    assert.equal(CameraScan.supported(), false);
  }
});

test('supported browsers show the button; a detected code closes the camera and is passed on', async () => {
  const { CameraScan, document, stopped } = load();
  const button = fakeElement('button');
  const results = [];
  CameraScan.mount(button, value => results.push(value));
  assert.equal(button.hidden, false);
  await button.listeners.click[0]();
  const dialog = document.body.children[0];
  assert.equal(dialog.open, true);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(results, ['4710000000017']);
  assert.equal(dialog.open, false);
  assert.equal(stopped.length, 1);
});

test('camera permission errors are shown in Chinese and the dialog stays closed', async () => {
  const { CameraScan, document } = load({ cameraError: Object.assign(new Error('denied'), { name: 'NotAllowedError' }) });
  const button = fakeElement('button');
  const errors = [];
  CameraScan.mount(button, () => {}, message => errors.push(message));
  await button.listeners.click[0]();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /沒有相機權限/);
  assert.equal(document.body.children[0].open, false);
});

test('sale checkout and stock transactions have camera buttons wired to the existing scan handlers', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(html, /id="sale-camera"[^>]*hidden/);
  assert.match(html, /id="transaction-camera"[^>]*hidden/);
  assert.match(html, /<script src="camera-scan\.js\?v=\d+"><\/script>/);
  assert.match(app, /CameraScan\?\.mount\(\$\('sale-camera'\), handleSaleScan/);
  assert.match(app, /CameraScan\?\.mount\(\$\('transaction-camera'\), handleTransactionScan/);
});
