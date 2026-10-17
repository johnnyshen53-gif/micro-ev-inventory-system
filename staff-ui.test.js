import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import test from 'node:test';
async function fixture(role='admin',link=async()=>false,list=async()=>({users:[]}),waitForStart=true) {
  const nodes=new Map();
  const node=()=>({value:'',hidden:false,disabled:false,children:[],listeners:{},textContent:'',dataset:{},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},addEventListener(e,f){this.listeners[e]=f;},focus(){},reset(){for(const [key,n] of nodes)if(key.startsWith('staff-'))n.value='';}});
  const $=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  $('staff-role').value='clerk';
  let creates=0,createdBody;
  const context={crypto:webcrypto,window:{AppConfig:{usernameLoginEnabled:true},AppAuth:{manageStaff:async body=>{
    if(body.action==='list')return list();
    if(body.action==='create'){creates++;createdBody=body;return {user:{id:'new-user',username:'staff01',displayName:'業務',role:body.role,active:true}};}
    return {ok:true};
  }}},document:{getElementById:$,createElement:node},confirm:()=>true,Option:function(label,value){return {textContent:label,value};}};
  vm.runInNewContext(await readFile(new URL('./staff-ui.js',import.meta.url),'utf8'),context);
  const startPromise=context.window.StaffUI.start({id:'manager',role},{getSalespeople:()=>[{id:'local-id',name:'業務',authUserId:''}],link});
  if(waitForStart)await startPromise;
  return {context,$,startPromise,creates:()=>creates,createdBody:()=>createdBody};
}
test('manager login can show the app before account list finishes loading',async()=>{
  let finishList;
  const list=new Promise(resolve=>{finishList=resolve;});
  const {$,startPromise}=await fixture('admin',async()=>false,()=>list,false);
  const ready=await Promise.race([startPromise.then(()=>true),new Promise(resolve=>setImmediate(()=>resolve(false)))]);
  finishList({users:[{id:'staff-1',username:'staff01',displayName:'業務',role:'clerk',active:true}]});
  await startPromise;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ready,true,'the account list must not block the login screen');
  assert.equal($('staff-list').children.length,1,'account list still loads afterward');
});
test('a failed account list response after logout cannot show a stale error',async()=>{
  let rejectList;
  const list=new Promise((_resolve,reject)=>{rejectList=reject;});
  const {context,$,startPromise}=await fixture('admin',async()=>false,()=>list,false);
  await startPromise;
  context.window.StaffUI.stop();
  rejectList(new Error('stale network error'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal($('staff-panel').hidden,true);
  assert.equal($('staff-message').textContent,'');
});
test('cloud account success and failed local link are recoverable without duplicate create',async()=>{
  const {$,creates}=await fixture();
  $('staff-username').value='staff01';$('staff-name').value='業務';$('staff-password').value='initial-password';$('staff-link-person').value='local-id';
  await $('staff-create-form').listeners.submit({preventDefault(){}});
  assert.equal(creates(),1);
  assert.equal($('staff-password').value,'');
  assert.match($('staff-message').textContent,/已建立.*未完成/);
  assert.equal($('staff-existing-user').value,'new-user');
  await $('staff-link-form').listeners.submit({preventDefault(){}});
  assert.equal(creates(),1);
});
test('clerk cannot trigger cloud management even when directly submitting hidden controls',async()=>{
  const {$,creates}=await fixture('clerk');
  assert.equal($('staff-panel').hidden,true);
  await $('staff-create-form').listeners.submit({preventDefault(){}});
  assert.equal(creates(),0);
});
test('manager-selected admin role is sent with account creation',async()=>{
  const {$,createdBody}=await fixture();
  $('staff-username').value='johnny';$('staff-name').value='johnny';$('staff-password').value='initial-password';$('staff-role').value='admin';
  await $('staff-create-form').listeners.submit({preventDefault(){}});
  assert.equal(createdBody().role,'admin');
  assert.equal($('staff-password').value,'');
});
