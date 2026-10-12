import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import test from 'node:test';
async function fixture(role='admin',link=async()=>false) {
  const nodes=new Map();
  const node=()=>({value:'',hidden:false,disabled:false,children:[],listeners:{},textContent:'',dataset:{},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},addEventListener(e,f){this.listeners[e]=f;},focus(){},reset(){for(const [key,n] of nodes)if(key.startsWith('staff-'))n.value='';}});
  const $=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  let creates=0;
  const context={crypto:webcrypto,window:{AppConfig:{usernameLoginEnabled:true},AppAuth:{manageStaff:async body=>{
    if(body.action==='list')return {users:[]};
    if(body.action==='create'){creates++;return {user:{id:'new-user',username:'staff01',displayName:'業務',role:'clerk',active:true}};}
    return {ok:true};
  }}},document:{getElementById:$,createElement:node},confirm:()=>true,Option:function(label,value){return {textContent:label,value};}};
  vm.runInNewContext(await readFile(new URL('./staff-ui.js',import.meta.url),'utf8'),context);
  await context.window.StaffUI.start({id:'manager',role},{getSalespeople:()=>[{id:'local-id',name:'業務',authUserId:''}],link});
  return {context,$,creates:()=>creates};
}
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
