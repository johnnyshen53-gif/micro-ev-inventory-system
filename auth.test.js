import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const context = { crypto: webcrypto, TextEncoder, window: {} };
vm.runInNewContext(await readFile(new URL('./auth.js', import.meta.url), 'utf8'), context);
const { createPasswordRecord, verifyPassword } = context.window.InventoryAuth;

test('creates a password record that accepts only the configured password', async () => {
  const record = await createPasswordRecord('correct-horse');

  assert.equal(typeof record.salt, 'string');
  assert.equal(typeof record.hash, 'string');
  assert.equal(JSON.stringify(record).includes('correct-horse'), false);
  assert.equal(await verifyPassword('correct-horse', record), true);
  assert.equal(await verifyPassword('wrong-password', record), false);
});

test('active login exposes the session account email alongside stable profile ID and role', async () => {
  const client = { auth: { getSession: async () => ({ data: { session: { user: { id: 'user-id', email: 'manager@example.com' } } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'user-id', display_name: '店長', role: 'admin', active: true } }) }) }) }),
  };
  const ctx = { URL, window: { AppConfig: { supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'public-test-key' }, supabase: { createClient: () => client } } };
  vm.runInNewContext(await readFile(new URL('./supabase-client.js', import.meta.url), 'utf8'), ctx);
  const user = await ctx.window.AppAuth.requireActiveUser();
  assert.equal(user.email, 'manager@example.com');
  assert.equal(user.id, 'user-id');
  assert.equal(user.role, 'admin');
});

test('username login normalizes input, stores verified tokens and rejects email without fallback', async()=>{
  const calls=[];
  const client={functions:{invoke:async(name,{body})=>{calls.push([name,body]);return {data:{accessToken:'access',refreshToken:'refresh'}};}},auth:{setSession:async(tokens)=>{calls.push(tokens);return {error:null};}}};
  const ctx={URL,window:{AppConfig:{supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'public',usernameLoginEnabled:true},supabase:{createClient:()=>client}}};
  vm.runInNewContext(await readFile(new URL('./supabase-client.js',import.meta.url),'utf8'),ctx);
  assert.equal((await ctx.window.AppAuth.signIn(' Johnny ','original-password')).error,null);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['staff-login',{username:'johnny',password:'original-password'}],{access_token:'access',refresh_token:'refresh'}]);
  assert.ok((await ctx.window.AppAuth.signIn('private@example.com','password')).error);
  assert.equal(calls.length,2);
});
test('a cancelled username login never installs its returned tokens',async()=>{
  let installed=false;
  const client={functions:{invoke:async()=>({data:{accessToken:'access',refreshToken:'refresh'}})},auth:{setSession:async()=>{installed=true;return {error:null};}}};
  const ctx={URL,window:{AppConfig:{supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'public',usernameLoginEnabled:true},supabase:{createClient:()=>client}}};
  vm.runInNewContext(await readFile(new URL('./supabase-client.js',import.meta.url),'utf8'),ctx);
  await ctx.window.AppAuth.signIn('johnny','password',()=>false);
  assert.equal(installed,false);
});
test('offline signout removes only the authentication token, keeping inventory backups',async()=>{
  const stored=new Map([['sb-example-auth-token','session'],['inventory-backup','keep']]);
  const client={auth:{signOut:async()=>{throw Error('offline');}}};
  const ctx={URL,localStorage:{removeItem:key=>stored.delete(key)},window:{AppConfig:{supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'public'},supabase:{createClient:()=>client}}};
  vm.runInNewContext(await readFile(new URL('./supabase-client.js',import.meta.url),'utf8'),ctx);
  await assert.rejects(ctx.window.AppAuth.signOut(),/offline/);
  assert.equal(stored.has('sb-example-auth-token'),false);assert.equal(stored.get('inventory-backup'),'keep');
});
