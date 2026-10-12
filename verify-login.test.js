import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./verify-login.js',import.meta.url),'utf8').catch(()=>'');
function fixture(adminStatus=200) {
  const nodes=new Map();let submit;const requests=[];
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='verify-password'?'original-password':'',disabled:false,textContent:'',addEventListener(_event,fn){submit=fn;}});return nodes.get(id);};
  const context={window:{AppConfig:{supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'public'}},document:{getElementById:$},fetch:async(url,options)=>{
    requests.push({url,body:options.body,headers:options.headers});
    if(url.endsWith('staff-login'))return {ok:true,json:async()=>({accessToken:'private-access',refreshToken:'private-refresh'})};
    if(url.endsWith('staff-admin'))return {ok:adminStatus===200,json:async()=>({users:[{username:'johnny',role:'admin',active:true}]})};
    if(url.endsWith('logout?scope=local'))return {ok:true};
    throw Error(url);
  }};
  vm.runInNewContext(source,context);
  return {$,requests,run:()=>{assert.equal(typeof submit,'function','verification form listener is missing');return submit({preventDefault(){}});}};
}
test('manager verification checks live admin access then revokes its temporary session',async()=>{
  const f=fixture();assert.equal(typeof f.run,'function');await f.run();
  assert.match(f.$('verify-result').textContent,/驗證成功/);
  assert.equal(f.$('verify-password').value,'');
  assert.equal(f.requests.length,3);
  assert.equal(f.requests[2].url,'https://example.supabase.co/auth/v1/logout?scope=local');
  assert.equal(f.requests[1].headers.Authorization,'Bearer private-access');
  assert.equal(f.$('verify-result').textContent.includes('private-access'),false);
});
test('failed live authorization cannot be reported as successful and still revokes the token',async()=>{
  const f=fixture(401);await f.run();
  assert.doesNotMatch(f.$('verify-result').textContent,/驗證成功/);
  assert.equal(f.$('verify-password').value,'');assert.equal(f.requests.length,3);
});
