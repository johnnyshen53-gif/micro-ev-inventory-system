import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
test('logout waits for in-flight storage without re-enabling actions and clears all transient state',async()=>{
  const source=await readFile(new URL('./app.js',import.meta.url),'utf8');
  let resolveSave,stored;const values=new Map();
  const $=id=>{if(!values.has(id))values.set(id,{hidden:false,value:'sensitive',replaceChildren(){},reset(){this.value='';}});return values.get(id);};
  const c={window:{AppAuthUI:{isActive:()=>c.active},StaffUI:{stop(){}}},active:true,state:{items:['old']},currentUser:{id:'one'},saleCart:['draft'],quotationLines:['draft'],purchaseLines:['draft'],purchaseSupplierId:'supplier',selectedWarrantyId:'warranty',pendingSave:null,appSessionEpoch:0,
    selectedPurchaseId:'draft',purchaseBusy:false,InventoryStorage:{saveState:next=>new Promise(resolve=>{resolveSave=()=>{stored=next;resolve(next);};})},setAppEnabled:value=>{c.enabled=value;},setStatus(){},emptyState:()=>({items:[]}),document:{querySelectorAll:()=>[]},renderMonthlySales(){},$};
  Object.assign(c, { saleSerialItemId: 'motor', saleSerialQuantity: 2, receiptPurchaseId: 'purchase', receiptSerialNumbersByItem: { motor: ['SECRET-SERIAL'] } });
  c.renderMonthlySales.assignmentMonth = '2026-10';
  c.renderMonthlySales.assignments = new Map([['S1', { salespersonId: 'private-person' }]]);
  c.renderMonthlySales.assignmentError = 'old error';
  vm.runInNewContext(source.slice(source.indexOf('async function saveState('),source.indexOf('function itemName(')),c);
  const cleanup=source.indexOf('async function resetAppSession(');assert.ok(cleanup>=0,'session cleanup is implemented');
  vm.runInNewContext(source.slice(cleanup,source.indexOf('async function bootstrap(',cleanup)),c);
  const save=c.saveState({items:['saved']});c.active=false;const logout=c.resetAppSession();resolveSave();
  assert.equal(await save,false);await logout;
  assert.deepEqual(stored,{items:['saved']});assert.equal(c.enabled,false);assert.equal(c.currentUser,null);
  assert.equal(c.saleCart.length,0);assert.equal(c.quotationLines.length,0);assert.equal(c.purchaseLines.length,0);assert.equal(c.state.items.length,0);
  assert.equal(c.saleSerialItemId, ''); assert.equal(c.receiptPurchaseId, ''); assert.equal(Object.keys(c.receiptSerialNumbersByItem).length, 0);
  assert.equal(c.renderMonthlySales.assignmentMonth, '');
  assert.equal(c.renderMonthlySales.assignments, null);
  assert.equal(c.renderMonthlySales.assignmentError, '');
});
