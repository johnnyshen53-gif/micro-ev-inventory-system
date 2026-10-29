import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 批次匯入品項（CSV）：解析、編碼、逐列檢查、全部正確才產生新狀態。
const context = { window: {}, crypto: globalThis.crypto, TextDecoder, document: { getElementById: () => null } };
vm.createContext(context);
vm.runInContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
vm.runInContext(await readFile(new URL('./item-import.js', import.meta.url), 'utf8'), context);
const { Inventory, ItemImport } = context.window;
const plain = value => JSON.parse(JSON.stringify(value));

const state = Inventory.validateState({ ...Inventory.emptyState(),
  items: [{ id: 'old', name: '煞車皮', category: '機構元件', sku: '3320261001001', barcode: '3320261001001', price: 350, cost: 180, stock: 2, minimumStock: 0, warrantyMonths: 0 }],
  suppliers: [{ id: 'sup', name: '宏達零件行', contact: '', phone: '', address: '', taxId: '', note: '', active: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }] });
const markups = { 電控元件: 35 };
const header = '品項名稱*,分類*,料號,條碼,成本,售價,目前庫存,最低庫存,保固月數,供應商,電壓,容量,固定售價,備註';

test('CSV parser handles quotes, commas, line breaks, CRLF and the Excel BOM', () => {
  assert.deepEqual(plain(ItemImport.parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"two\nlines",3')), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '3']]);
  const big5 = new Uint8Array([0xab, 0x7e, 0xb6, 0xb5]); // 「品項」的 Big5 編碼
  assert.equal(ItemImport.decodeCsv(big5.buffer), '品項');
  assert.equal(ItemImport.decodeCsv(new TextEncoder().encode('品項').buffer), '品項');
  assert.ok(ItemImport.templateCsv().startsWith('﻿品項名稱*,分類*,車種*,料號'));
});

test('valid rows get auto SKUs, markup prices and initial stock; nothing is saved while any row is wrong', () => {
  const ok = ItemImport.buildPreview(state, [header,
    '行車記錄器,電控元件,,,"1,000",,5,1,12,宏達零件行,,,,前後雙鏡頭',
    '輪胎 90/90-12,機構元件,,,800,1450,3,,,,,,,',
    '鋰電池,電池,,,9000,12000,0,,12,,48,24,是,',
    '煞車皮,機構元件,TIRE-01,,100,200,0,,,,,,,'].join('\n'), { inventory: Inventory, markups });
  assert.equal(ok.errorCount, 0);
  const created = ok.nextState.items.slice(1);
  assert.equal(created.length, 4);
  assert.deepEqual(plain(created.map(item => [item.name, item.price, item.stock, item.priceLocked])),
    [['行車記錄器', 1350, 5, false], ['輪胎 90/90-12', 1450, 3, false], ['鋰電池 48V 24Ah', 12000, 0, true], ['煞車皮', 200, 0, false]]);
  assert.match(created[0].sku, /^22\d{11}$/);
  assert.equal(created[0].barcode, created[0].sku);
  assert.equal(created[0].supplierId, 'sup');
  assert.equal(created[3].sku, 'TIRE-01');
  assert.equal(ok.rows[0].priceFromMarkup, true);
  assert.deepEqual(plain(ok.rows[3].warnings), ['已有同名品項']);

  const bad = ItemImport.buildPreview(state, [header,
    ',電控元件,,,1,2,,,,,,,,',
    '安全帽,配件,,,1,2,,,,,,,,',
    '車身 A,車身,,,1,2,3,,,,,,,',
    '鋰電池,電池,,,1,2,0,,,,,,,',
    '尾燈,外觀元件,,,100,,,,,,,,,',
    '舊料號,機構元件,3320261001001,,1,2,,,,,,,,',
    '同檔A,機構元件,DUP-1,,1,2,,,,,,,,',
    '同檔B,機構元件,DUP-1,,1,2,,,,,,,,',
    '供應商錯,機構元件,,,1,2,,,,不存在行,,,,',
    '數字錯,機構元件,,,abc,2,,,,,,,,',
    '正確的,機構元件,,,1,2,,,,,,,,'].join('\n'), { inventory: Inventory, markups });
  assert.equal(bad.nextState, null);
  assert.deepEqual(plain(bad.rows.map(row => row.errors[0] ?? 'OK')), [
    '品項名稱不可空白', '分類須為：車身、電池、電控元件、機構元件、外觀元件', '車身／電池匯入時庫存須為 0，之後請用進貨收貨登錄序號',
    '電池須填寫電壓與容量（1～99 整數）', '售價未填，且「外觀元件」尚未設定加成，請填售價', '料號「3320261001001」已存在',
    'OK', '料號「DUP-1」已存在', '找不到供應商「不存在行」，請先在供應商管理建立', '成本必須是數字', 'OK']);
  assert.equal(bad.rows[0].line, 2);
});

test('file-level problems are reported before any row is checked', () => {
  const run = text => ItemImport.buildPreview(state, text, { inventory: Inventory, markups }).fileError;
  assert.match(run(''), /檔案是空的/);
  assert.match(run('名稱,分類\nA,電控元件'), /缺少欄位：品項名稱/);
  assert.match(run(header), /沒有要匯入/);
  assert.match(run([header, ...Array.from({ length: 501 }, (_, i) => `品${i},機構元件,,,1,2`)].join('\n')), /最多匯入 500 列/);
});

test('the import panel is on the admin manage page', async () => {
  const [html, app] = await Promise.all(['index.html', 'app.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  for (const id of ['item-import-template', 'item-import-file', 'item-import-status', 'item-import-preview', 'item-import-rows', 'item-import-confirm', 'item-import-cancel']) assert.match(html, new RegExp(`id="${id}"`), id);
  const manage = html.slice(html.indexOf('data-page="manage"'), html.indexOf('</section>', html.indexOf('data-page="manage"')));
  assert.match(manage, /批次匯入品項（CSV）/);
  assert.match(html, /<script src="item-import\.js\?v=\d+"><\/script>/);
  assert.match(app, /getMarkups: \(\) => priceMarkups/);
  assert.match(app, /window\.ItemImport\?\.instance\?\.clear\(\);/);
});
