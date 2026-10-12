(() => {
  const $=id=>document.getElementById(id);
  const {supabaseUrl,supabasePublishableKey}=window.AppConfig;
  const headers={apikey:supabasePublishableKey,'Content-Type':'application/json'};
  $('verify-form').addEventListener('submit',async event=>{
    event.preventDefault();if($('verify-submit').disabled)return;
    $('verify-submit').disabled=true;$('verify-result').textContent='驗證中…';
    let token='',verified=false,revoked=false;
    try {
      const login=await fetch(supabaseUrl+'/functions/v1/staff-login',{method:'POST',headers,body:JSON.stringify({username:'johnny',password:$('verify-password').value})});
      const data=await login.json();
      if(!login.ok||typeof data.accessToken!=='string')throw Error(data.error||'登入驗證失敗。');
      token=data.accessToken;
      const response=await fetch(supabaseUrl+'/functions/v1/staff-admin',{method:'POST',headers:{...headers,Authorization:`Bearer ${token}`},body:JSON.stringify({action:'list'})});
      const staff=await response.json();
      if(!response.ok||!staff.users?.some(user=>user.username==='johnny'&&user.role==='admin'&&user.active))throw Error('店長權限驗證失敗，請回報此訊息。');
      verified=true;
    }catch(error){$('verify-result').textContent=error.message||'驗證暫時無法完成，請稍後再試。';}
    finally {
      $('verify-password').value='';
      if(token)try {
        const result=await fetch(supabaseUrl+'/auth/v1/logout?scope=local',{method:'POST',headers:{...headers,Authorization:`Bearer ${token}`}});
        revoked=result.ok;
      }catch { /* Tokens are never persisted; report the failed server cleanup. */ }
      token='';
      if(verified)$('verify-result').textContent=revoked?'驗證成功：johnny 可使用原密碼登入，店長權限正常。測試工作階段已登出。':'登入與權限已通過，但測試工作階段登出未完成，請稍後重試並回報。';
      $('verify-submit').disabled=false;
    }
  });
})();
