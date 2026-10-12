import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./idle-session.js',import.meta.url),'utf8').catch(()=>'');
function fixture(shared=new Map(),tabStorage=new Map()) {
  let now=1000000,timerId=0;const timers=new Map(),listeners=new Map();
  const target={addEventListener(e,f){if(!listeners.has(e))listeners.set(e,new Set());listeners.get(e).add(f);},removeEventListener(e,f){listeners.get(e)?.delete(f);}};
  const storage={getItem:key=>shared.get(key)??null,setItem:(key,value)=>shared.set(key,value)};
  const context={window:{...target},document:{...target},localStorage:storage,sessionStorage:{getItem:key=>tabStorage.get(key)??null,setItem:(key,value)=>tabStorage.set(key,value),removeItem:key=>tabStorage.delete(key)},Date:{now:()=>now},setTimeout:(f,ms)=>{timers.set(++timerId,{f,at:now+ms});return timerId;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(source,context);
  return {context,shared,storage,get now(){return now;},set now(v){now=v;},fire(e){for(const f of [...(listeners.get(e)||[])])f({preventDefault(){},stopImmediatePropagation(){}});},run(){for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.f();}},start(options){return context.window.IdleSession.start({userId:'user',...options});}};
}
test('idle expiry locks at exactly five minutes once and late activity cannot revive it',()=>{
  const env=fixture();let expired=0;env.start({fresh:true,onExpire:()=>expired++});
  env.now+=299999;env.run();assert.equal(expired,0);
  env.now++;env.fire('keydown');assert.equal(expired,1);
  env.fire('pointermove');env.run();assert.equal(expired,1);
});
test('a tab lock survives reload even if localStorage writes subsequently recover',()=>{
  const shared=new Map(),tabStorage=new Map();const first=fixture(shared,tabStorage);
  first.start({fresh:true,onExpire:()=>{}});
  first.storage.setItem=()=>{throw Error('temporarily denied');};first.fire('keydown');
  let expired=0;fixture(shared,tabStorage).start({fresh:false,onExpire:()=>expired++});
  assert.equal(expired,1);
});
test('activity extends the deadline but focus and background wakeups do not',()=>{
  const env=fixture();let expired=0;env.start({fresh:true,onExpire:()=>expired++});
  env.now+=200000;env.fire('pointermove');
  env.now+=200000;env.fire('focus');assert.equal(expired,0);
  env.now+=100000;env.fire('visibilitychange');assert.equal(expired,1);
});
test('reload and other tabs share activity and lock but not reset the timer',()=>{
  const a=fixture();let expired=0;a.start({fresh:true,onExpire:()=>expired++});
  const b=fixture(a.shared);b.now=a.now+100000;b.start({fresh:false,onExpire:()=>expired++});
  b.now+=100000;b.fire('pointerdown');
  a.now=b.now+299999;a.fire('storage');assert.equal(expired,0);
  a.now++;a.run();assert.equal(expired,1);
  b.fire('storage');assert.equal(expired,2);
  const reload=fixture(a.shared);reload.now=a.now;reload.start({fresh:false,onExpire:()=>expired++});assert.equal(expired,3);
});
test('clock rollback and unavailable storage fail closed and stop releases listeners',()=>{
  const env=fixture();let expired=0;const watcher=env.start({fresh:true,onExpire:()=>expired++});
  env.now--;env.fire('keydown');assert.equal(expired,1);watcher.stop();
  env.now+=999999;env.run();assert.equal(expired,1);
  const broken=fixture();broken.storage.setItem=()=>{throw Error('denied');};broken.start({fresh:true,onExpire:()=>expired++});assert.equal(expired,2);
});
test('reload cannot restore an unlocked old marker when storage writes fail',()=>{
  const first=fixture();first.start({fresh:true,onExpire:()=>{}});
  first.storage.setItem=()=>{throw Error('denied');};first.fire('keydown');
  const reload=fixture(first.shared);reload.storage.setItem=()=>{throw Error('denied');};
  let expired=0;reload.start({fresh:false,onExpire:()=>expired++});
  assert.equal(expired,1);
});
