import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./auth-ui.js',import.meta.url),'utf8');
async function fixture({restore,signIn=async()=>({error:null}),signOut=async()=>({error:null}),bootstrap=async()=>{}}={}) {
  const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:true,textContent:'',disabled:false,type:'email',listeners:{},focus(){},addEventListener(e,f){this.listeners[e]=f;},setAttribute(k,v){this[k]=v;}});return nodes.get(id);};
  let expire,cleanups=0;const user={id:'manager',role:'admin',displayName:'店長'};
  const ctx={window:{AppConfig:{usernameLoginEnabled:true},AppAuth:{requireActiveUser:restore||(async()=>user),signIn,signOut},IdleSession:{start({onExpire}){expire=onExpire;return {stop(){},lock(){onExpire('manual');}};}}},document:{getElementById:$,querySelectorAll:()=>[],querySelector:()=>({textContent:''}),body:{dataset:{}}}};
  vm.runInNewContext(source,ctx);
  ctx.window.AppAuthUI.start(bootstrap,async()=>cleanups++);
  await new Promise(resolve=>setImmediate(resolve));
  return {ctx,$,expire:()=>expire('idle'),cleanups:()=>cleanups};
}
test('idle logout immediately hides app and removes role even if server signout fails',async()=>{
  const {$,ctx,expire,cleanups}=await fixture({signOut:async()=>{throw Error('offline');}});
  assert.equal($('app-shell').hidden,false);expire();
  assert.equal($('app-shell').hidden,true);assert.equal(ctx.document.body.dataset.role,undefined);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(cleanups(),1);assert.match($('login-error').textContent,/5 分鐘/);
});
test('logout invalidates a pending login and its automatic restoration',async()=>{
  let restore,login;const user={id:'manager',role:'admin'};
  const {$,ctx}=await fixture({restore:()=>new Promise(resolve=>{restore=resolve;}),signIn:()=>new Promise(resolve=>{login=resolve;})});
  const submitted=$('login-form').listeners.submit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  restore(user);await new Promise(resolve=>setImmediate(resolve));
  assert.equal($('app-shell').hidden,true,'old restoration must not expose the app');
  $('sign-out-button').listeners.click();
  login({error:null});await submitted;
  assert.equal($('app-shell').hidden,true);assert.equal(ctx.window.AppAuthUI.isActive(),false);
});
test('expired bootstrap cannot reveal stale data after logout',async()=>{
  let finish;const bootstrap=()=>new Promise(resolve=>{finish=resolve;});
  const {$,expire}=await fixture({bootstrap});expire();finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal($('app-shell').hidden,true);
});
test('username gateway uses a text field and manual logout also clears active identity',async()=>{
  const {$,ctx,cleanups}=await fixture();assert.equal($('login-email').type,'text');
  await $('sign-out-button').listeners.click();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(cleanups(),1);assert.equal(ctx.window.AppAuthUI.isActive(),false);
});
test('offline signout and failed storage writes cannot restore the app after reload',async()=>{
  const idleSource=await readFile(new URL('./idle-session.js',import.meta.url),'utf8');
  const stored=new Map([['shop-idle-session-v1',JSON.stringify({userId:'manager',lastActivity:Date.now(),locked:false})]]);
  const {$,ctx}=await fixture({restore:async()=>{throw Error('no initial restore');},signOut:async()=>{throw Error('offline');}});
  Object.assign(ctx,{Date,setTimeout,clearTimeout,localStorage:{getItem:key=>stored.get(key)||null,setItem(){throw Error('writes denied');}}});
  ctx.window.addEventListener=()=>{};ctx.window.removeEventListener=()=>{};
  ctx.document.addEventListener=()=>{};ctx.document.removeEventListener=()=>{};
  vm.runInNewContext(idleSource,ctx);
  ctx.window.AppAuth.requireActiveUser=async()=>({id:'manager',role:'admin'});
  ctx.window.AppAuthUI.start(async()=>{});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal($('app-shell').hidden,true);assert.equal(ctx.window.AppAuthUI.isActive(),false);
});
