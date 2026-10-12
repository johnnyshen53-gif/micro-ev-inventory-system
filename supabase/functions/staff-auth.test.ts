import test from 'node:test';
import { deepStrictEqual as assertEquals } from 'node:assert';
const module = await import('./_shared/staff-auth.ts').catch(()=>({}));
const {handleLogin,handleAdmin}=module as Record<string, (...args:any[])=>Promise<Response>>;
test('staff auth handlers are available',()=>assertEquals(typeof handleLogin,'function'));

const manager='10000000-0000-4000-8000-000000000001';
function fixture() {
  const profiles=new Map([[manager,{id:manager,username:'johnny',display_name:'店長',role:'admin',active:true}]]);
  let attempts=0;
  const deps={
    authenticate: async (_token:string)=>({id:manager,sessionId:'session'}),
    sessionValid: async ()=>true,
    profile: async (id:string)=>profiles.get(id),
    list: async ()=>[...profiles.values()],
    reserve: async ()=>++attempts<=10,
    finish: async (_name:string,_success:boolean)=>{},
    identity: async (name:string)=>name==='johnny'?{user_id:manager,email:'private@example.com',active:true,ready:true}:null,
    passwordLogin: async (email:string,password:string)=>{
      assertEquals(email,'private@example.com');
      return password==='original-password'?{user:{id:manager},access_token:'access',refresh_token:'refresh'}:null;
    },
    create: async (_actor:string,_body:Record<string,unknown>)=>{throw new Error('unconfigured');},
    link: async (_actor:string,_body:Record<string,unknown>)=>{},
    reset: async (_actor:string,_body:Record<string,unknown>)=>{},
    deactivate: async (_actor:string,_body:Record<string,unknown>)=>{},
  };
  return {deps,profiles};
}
const request=(body:object,token='token')=>new Request('https://example.test',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
test('username password login returns tokens but never returns email correspondence',async()=>{
  const {deps}=fixture();
  const r=await handleLogin(request({username:' Johnny ',password:'original-password'}),deps);
  assertEquals(r.status,200);
  assertEquals(await r.json(),{accessToken:'access',refreshToken:'refresh'});
  assertEquals(r.headers.get('Cache-Control'),'no-store');
});
test('unknown wrong password inactive and email login have indistinguishable failures',async()=>{
  const {deps,profiles}=fixture();
  for(const body of [{username:'unknown',password:'original-password'},{username:'johnny',password:'wrong-password'},{username:'private@example.com',password:'original-password'}]) {
    const r=await handleLogin(request(body),deps);assertEquals(r.status,401);
    assertEquals(await r.json(),{error:'帳號或密碼不正確，或帳號已停用'});
  }
  profiles.get(manager)!.active=false;
  assertEquals((await handleLogin(request({username:'johnny',password:'original-password'}),deps)).status,401);
});
test('login ignores forged IP headers and honors the shared persistent limiter',async()=>{
  const {deps}=fixture();
  const forged=request({username:'johnny',password:'original-password'});
  forged.headers.set('cf-connecting-ip','192.0.2.199');
  forged.headers.set('x-forwarded-for','198.51.100.2');
  assertEquals((await handleLogin(forged,deps)).status,200);
  for(let i=0;i<10;i++) await handleLogin(request({username:'unknown',password:'wrong-password'}),deps);
  assertEquals((await handleLogin(request({username:'johnny',password:'original-password'}),deps)).status,429);
});
test('manager endpoints reject anonymous clerk disabled and revoked sessions',async()=>{
  const {deps,profiles}=fixture();
  assertEquals((await handleAdmin(new Request('https://example.test',{method:'POST',body:'{}'}),deps)).status,401);
  profiles.get(manager)!.role='clerk';
  assertEquals((await handleAdmin(request({action:'list',role:'admin'}),deps)).status,403);
  profiles.get(manager)!.role='admin';profiles.get(manager)!.active=false;
  assertEquals((await handleAdmin(request({action:'list'}),deps)).status,403);
  profiles.get(manager)!.active=true;deps.sessionValid=async()=>false;
  assertEquals((await handleAdmin(request({action:'list'}),deps)).status,401);
});
test('staff list excludes emails and management validates password and role',async()=>{
  const {deps}=fixture();
  assertEquals(await (await handleAdmin(request({action:'list'}),deps)).json(),{users:[{id:manager,username:'johnny',displayName:'店長',role:'admin',active:true}]});
  assertEquals((await handleAdmin(request({action:'create',username:'staff01',password:'short',displayName:'業務'}),deps)).status,400);
  assertEquals((await handleAdmin(request({action:'create',role:'admin',username:'staff01',password:'long-password',displayName:'業務'}),deps)).status,400);
});
test('only supported HTTP methods are accepted',async()=>{
  const {deps}=fixture();
  assertEquals((await handleLogin(new Request('https://example.test'),deps)).status,405);
  assertEquals((await handleLogin(new Request('https://example.test',{method:'OPTIONS'}),deps)).status,204);
});
