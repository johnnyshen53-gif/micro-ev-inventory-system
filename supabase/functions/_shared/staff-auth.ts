type Row = {id:string;username?:string|null;display_name:string;role:string;active:boolean};
type Body = Record<string,unknown>;
export type Dependencies = {
  reserve:(username:string)=>Promise<boolean>;
  finish:(username:string,success:boolean)=>Promise<void>;
  identity:(username:string)=>Promise<{user_id:string;email:string;ready:boolean;active:boolean}|null>;
  passwordLogin:(email:string,password:string)=>Promise<{user:{id:string};access_token:string;refresh_token:string}|null>;
  authenticate:(token:string)=>Promise<{id:string;sessionId:string}|null>;
  sessionValid:(id:string,sessionId:string)=>Promise<boolean>;
  profile:(id:string)=>Promise<Row|undefined>;
  list:()=>Promise<Row[]>;
  create:(actor:string,body:Body)=>Promise<Row>;
  link:(actor:string,body:Body)=>Promise<void>;
  reset:(actor:string,body:Body)=>Promise<void>;
  deactivate:(actor:string,body:Body)=>Promise<void>;
};
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
export const json=(body:object,status=200)=>new Response(JSON.stringify(body),{status,headers});
const summary=(p:Row)=>({id:p.id,username:p.username??'',displayName:p.display_name,role:p.role,active:p.active});
export const username=(value:unknown)=>typeof value==='string'?value.trim().toLowerCase():'';
const validName=(name:string)=>/^[a-z0-9_-]{3,32}$/.test(name);
const validId=(id:unknown)=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
function method(req:Request) {
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(req.method!=='POST')return json({error:'只接受 POST 請求'},405);
}
async function readBody(req:Request):Promise<Body> {
  const text=await req.text();
  if(text.length>16384)throw new Error('request too large');
  const result=JSON.parse(text);
  if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('invalid body');
  return result;
}
const rejected=()=>json({error:'帳號或密碼不正確，或帳號已停用'},401);
export async function handleLogin(req:Request,deps:Dependencies):Promise<Response> {
  const early=method(req);if(early)return early;
  try {
    const body=await readBody(req),name=username(body.username);
    if(!await deps.reserve(name.slice(0,32)||'invalid'))return json({error:'嘗試次數過多，請稍後再試'},429);
    if(!validName(name)||typeof body.password!=='string'||!body.password||body.password.length>1024)return rejected();
    const identity=await deps.identity(name);
    if(!identity?.ready||!identity.active)return rejected();
    const session=await deps.passwordLogin(identity.email,body.password);
    const profile=session?await deps.profile(session.user.id):undefined;
    if(!session||session.user.id!==identity.user_id||!profile?.active)return rejected();
    await deps.finish(name,true);
    return json({accessToken:session.access_token,refreshToken:session.refresh_token});
  } catch {return json({error:'登入服務暫時無法使用，請稍後再試'},503);}
}
export async function handleAdmin(req:Request,deps:Dependencies):Promise<Response> {
  const early=method(req);if(early)return early;
  try {
    const token=req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    const user=token?await deps.authenticate(token):null;
    if(!user||!await deps.sessionValid(user.id,user.sessionId))return json({error:'請重新登入'},401);
    const profile=await deps.profile(user.id);
    if(!profile?.active||profile.role!=='admin')return json({error:'僅店長可管理帳號'},403);
    const body=await readBody(req);
    if(body.action==='list')return json({users:(await deps.list()).map(summary)});
    if('role' in body)return json({error:'不可指定或變更權限'},400);
    if(body.action==='create') {
      body.username=username(body.username);
      if(!validName(body.username as string)||!validId(body.requestId)||typeof body.displayName!=='string'||!body.displayName.trim()||body.displayName.length>100||typeof body.password!=='string'||body.password.length<12||body.password.length>1024)return json({error:'請確認帳號、姓名及至少 12 字元的密碼'},400);
      return json({user:summary(await deps.create(user.id,body))});
    }
    if(!validId(body.userId))return json({error:'帳號識別不正確'},400);
    if(body.action==='link-existing') {
      body.username=username(body.username);
      if(!validName(body.username as string))return json({error:'帳號格式不正確'},400);
      await deps.link(user.id,body);
    }else if(body.action==='reset-password') {
      if(typeof body.password!=='string'||body.password.length<12||body.password.length>1024)return json({error:'密碼至少 12 字元'},400);
      await deps.reset(user.id,body);
    }else if(body.action==='deactivate') {
      await deps.deactivate(user.id,body);
    }else return json({error:'不支援的操作'},400);
    return json({ok:true});
  }catch{return json({error:'操作未完成：請確認帳號未重複、密碼符合政策，或稍後重試'},400);}
}
