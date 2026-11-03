import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 銷售結帳：「確認結帳」旁邊有「取消結帳」，確認後清空整張訂單（不會動到庫存）。
test('cancel checkout asks first, then clears the cart, promotions and the form', async () => {
  const [app, html] = await Promise.all(['app.js', 'index.html'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  assert.match(html, /<button type="submit">確認結帳<\/button><button id="sale-cancel" type="button" class="secondary">取消結帳<\/button>/);
  const els = {};
  const node = () => ({ value: '', hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, reset() { this.wasReset = true; }, replaceChildren() {} });
  let answer = false, status = '';
  const ctx = {
    $: id => (els[id] ??= node()), saleCart: [{ itemId: 'a' }], saleCheckoutId: 'x', saleSerialItemId: 'a', saleSerialQuantity: 2, pendingSave: false,
    confirm: () => answer, window: { PromotionUI: { checkout: { reset() { ctx.promoReset = true; } } } },
    syncSaleDate() {}, clearFormError() {}, renderSaleCart() {}, render() {}, setStatus: message => { status = message; },
  };
  const start = app.indexOf('// 清空整張訂單（結帳完成或取消結帳都用）');
  vm.runInNewContext(`${app.slice(start, app.indexOf('// 銷售日期欄：最晚只能選今天'))}; this.read = () => ({ saleCart, saleCheckoutId });`
    .replace(/^/, 'var saleCart = this.saleCart, saleCheckoutId = this.saleCheckoutId, saleSerialItemId, saleSerialQuantity, pendingSave = false;\n'), ctx);
  els['sale-cancel'].listeners.click();
  assert.equal(ctx.read().saleCart.length, 1, '按「取消」不清空');
  answer = true;
  els['sale-cancel'].listeners.click();
  assert.equal(ctx.read().saleCart.length, 0);
  assert.equal(ctx.read().saleCheckoutId, '');
  assert.equal(ctx.promoReset, true);
  assert.equal(els['sale-form'].wasReset, true);
  assert.match(status, /已取消結帳/);
});
