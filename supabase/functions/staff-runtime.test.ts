import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Execute the real runtime with only the external SDK and environment replaced.
const source=(await readFile(new URL('./_shared/staff-runtime.ts',import.meta.url),'utf8'))
  .replace(/^import .*\n/gm,'').replace('export function dependencies():Dependencies','function dependencies()')
  .replace('function key(map:string,legacy:string)','function key(map,legacy)')
  .replace('async function rpc(name:string,args:Record<string,unknown>)','async function rpc(name,args)')
  .replace('async function profile(id:string)','async function profile(id)')
  .replace(/ as string/g,'').replace(/\)!/g,')');

function fixture({failRead=false,lateRetry=false}={}) {
  const row={id:'target',username:null,display_name:'',role:'clerk',active:true};
  let completed=false,bans=0,updates=0;
  const admin={auth:{admin:{getUserById:async()=>({data:{user:{id:'target'}}}),updateUserById:async(_id,fields)=>{if(fields.ban_duration!=='none')bans++;return {error:null};}}},
    rpc:async(name)=>{
      if(name==='prepare_staff_account')return {data:{status:'pending',reserved_user_id:'target'}};
      if(name==='complete_staff_account') {if(!completed){completed=true;Object.assign(row,{username:'sales_01',active:true});}return {data:'target'};}
      throw Error(name);
    },
    from:()=>({
      update:fields=>{
        const query={eq(){return query;},is(_key,value){query.onlyUnlinked=value===null;return query;},onlyUnlinked:false,
          then(resolve){if(lateRetry&&updates++===0){completed=true;Object.assign(row,{username:'sales_01',active:true});}
            if(!query.onlyUnlinked||row.username===null)Object.assign(row,fields);resolve({error:null});}};return query;
      },
      select:()=>({eq:()=>({maybeSingle:async()=>failRead?{error:Error('lost response')}:{data:{...row}}})})
    })};
  const ctx={createClient:()=>admin,Deno:{env:{get:()=>''}}};
  vm.runInNewContext(source,ctx);
  return {deps:ctx.dependencies(),row,bans:()=>bans};
}
test('a late duplicate create cannot disable the completed identity',async()=>{
  const f=fixture({lateRetry:true});
  await f.deps.create('manager',{username:'sales_01',requestId:'request',displayName:'Sales',password:'long-password'});
  assert.equal(f.row.active,true);assert.equal(f.bans(),0);
});
test('a lost post-completion response does not compensate a completed identity',async()=>{
  const f=fixture({failRead:true});
  await assert.rejects(f.deps.create('manager',{username:'sales_01',requestId:'request',displayName:'Sales',password:'long-password'}));
  assert.equal(f.row.active,true);assert.equal(f.bans(),0);
});
