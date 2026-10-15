import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
import type {Dependencies} from './staff-auth.ts';
function key(map:string,legacy:string) {
  const value=JSON.parse(Deno.env.get(map)||'{}').default;
  return value?(Deno.env.get(value)||value):(Deno.env.get(legacy)||'');
}
export function dependencies():Dependencies {
  const url=Deno.env.get('SUPABASE_URL')||'';
  const publicKey=key('SUPABASE_PUBLISHABLE_KEYS','SUPABASE_ANON_KEY');
  const secret=key('SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY');
  const options={auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false}};
  const admin=createClient(url,secret,options);
  async function rpc(name:string,args:Record<string,unknown>) {
    const {data,error}=await admin.rpc(name,args);if(error)throw error;return data;
  }
  async function profile(id:string) {
    const {data,error}=await admin.from('profiles').select('id,username,display_name,role,active').eq('id',id).maybeSingle();
    if(error)throw error;return data??undefined;
  }
  return {
    reserve:name=>rpc('reserve_staff_login',{p_username:name}),
    finish:async(name,success)=>{await rpc('finish_staff_login',{p_username:name,p_success:success});},
    identity:async name=>(await rpc('staff_identity',{p_username:name}))?.[0]??null,
    passwordLogin:async(email,password)=>{
      const {data,error}=await createClient(url,publicKey,options).auth.signInWithPassword({email,password});
      return error?null:data.session;
    },
    authenticate:async token=>{
      const {data,error}=await admin.auth.getUser(token);if(error||!data.user)return null;
      try {
        const encoded=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
        const claims=JSON.parse(atob(encoded));
        return typeof claims.session_id==='string'?{id:data.user.id,sessionId:claims.session_id}:null;
      }catch{return null;}
    },
    sessionValid:(id,sessionId)=>rpc('staff_session_valid',{p_user_id:id,p_session_id:sessionId}),
    profile,
    list:async()=>{const {data,error}=await admin.from('profiles').select('id,username,display_name,role,active').order('display_name');if(error)throw error;return data||[];},
    create:async(actor,body)=>{
      const prepared=await rpc('prepare_staff_account',{p_actor:actor,p_request:body.requestId,p_username:body.username,p_role:body.role});
      if(prepared.status==='complete')return (await profile(prepared.user_id))!;
      const target=prepared.reserved_user_id;
      const existing=await admin.auth.admin.getUserById(target);
      if(!existing.data.user) {
        const result=await admin.auth.admin.createUser({id:target,email:`${target}@staff.invalid`,password:body.password as string,email_confirm:true,ban_duration:'876000h'});
        if(result.error)throw result.error;
      }
      // Conditional update is rechecked under the row lock after a competing completion.
      const disabled=await admin.from('profiles').update({active:false}).eq('id',target).is('username',null);if(disabled.error)throw disabled.error;
      const unban=await admin.auth.admin.updateUserById(target,{ban_duration:'none'});if(unban.error)throw unban.error;
      // Pending accounts stay inactive/unmapped; never compensate a possibly committed completion.
      await rpc('complete_staff_account',{p_actor:actor,p_request:body.requestId,p_display_name:(body.displayName as string).trim()});
      return (await profile(target))!;
    },
    link:async(actor,body)=>{await rpc('link_staff_account',{p_actor:actor,p_user_id:body.userId,p_username:body.username});},
    reset:async(actor,body)=>{
      // GoTrue UpdatePassword(nil) revokes every session, unlike passing a UUID to signOut.
      const {error}=await admin.auth.admin.updateUserById(body.userId as string,{password:body.password as string});if(error)throw error;
      await rpc('control_staff_account',{p_actor:actor,p_user_id:body.userId,p_action:'reset-password'});
    },
    deactivate:async(actor,body)=>{
      await rpc('control_staff_account',{p_actor:actor,p_user_id:body.userId,p_action:'deactivate'});
      const {error}=await admin.auth.admin.updateUserById(body.userId as string,{ban_duration:'876000h'});if(error)throw error;
    },
  };
}
