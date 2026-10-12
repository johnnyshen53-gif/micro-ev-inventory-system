(() => {
  const $ = (id) => document.getElementById(id);
  let idle=null, active=false, generation=0, signOutPending=Promise.resolve(), loginPending=Promise.resolve(), onSignedOut=()=>{};

  function applyRole(user) {
    document.body.dataset.role = user.role;
    document.querySelectorAll('[data-role="admin"]').forEach((element) => { element.hidden = user.role !== 'admin'; });
    $('current-user').textContent = `${user.displayName || '使用者'}｜${user.role === 'admin' ? '管理員' : '店員'}`;
  }

  function showLogin(message = '') {
    generation++;active=false;idle?.stop();idle=null;
    delete document.body.dataset.role;
    $('app-shell').hidden = true;
    $('auth-shell').hidden = false;
    $('login-error').textContent = message;
    $('login-error').hidden = !message;
    $('login-password').value = '';
    $('login-email').focus();
  }

  function showApp() {
    $('auth-shell').hidden = true;
    $('app-shell').hidden = false;
  }

  function logout(reason='manual') {
    showLogin(reason==='idle'?'閒置超過 5 分鐘，請重新登入。':reason==='changed'?'登入身分已變更，請重新登入。':'已登出。');
    const cleanup=Promise.resolve(onSignedOut());
    const pending=loginPending;
    signOutPending=(async()=>{
      try {await pending;}catch { /* A rejected login must not prevent logout. */ }
      try {if(reason!=='changed')await window.AppAuth.signOut();}catch { /* Local idle marker remains locked on network failure. */ }
      await cleanup;
    })();
    return signOutPending;
  }

  async function accept(user,fresh,onAuthenticated) {
    const token=++generation;active=true;
    const watcher=window.IdleSession.start({userId:user.id,fresh,onExpire:logout});
    if(token!==generation){watcher.stop();return;}
    idle=watcher;
    applyRole(user);
    await onAuthenticated(user,()=>token===generation&&active);
    if(token===generation&&active)showApp();
  }

  function start(onAuthenticated,cleanup=()=>{}) {
    onSignedOut=cleanup;
    if(window.AppConfig?.usernameLoginEnabled) {
      const input=$('login-email');input.type='text';input.autocomplete='username';input.maxLength=32;input.setAttribute('aria-label','登入帳號');
      document.querySelector('label[for="login-email"]').textContent='登入帳號';
    }
    $('login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('login-submit');
      button.disabled = true;
      $('login-error').hidden = true;
      const token=++generation;
      const current=()=>token===generation;
      try {
        await signOutPending;
        if(!current())return;
        loginPending=window.AppAuth.signIn($('login-email').value.trim(), $('login-password').value,current);
        const { error } = await loginPending;
        if(!current())return;
        if (error) throw error;
        const user = await window.AppAuth.requireActiveUser();
        if(!current())return;
        await accept(user,true,onAuthenticated);
      } catch (error) {
        if(current())showLogin(error.message === 'Invalid login credentials' ? '帳號或密碼不正確。' : error.message);
      } finally {
        button.disabled = false;
      }
    });

    $('sign-out-button').addEventListener('click', () => idle ? idle.lock() : logout());

    const token=generation;
    window.AppAuth.requireActiveUser().then(async (user) => {
      if(token===generation)await accept(user,false,onAuthenticated);
    }).catch(() => {if(token===generation)showLogin();});
  }

  window.AppAuthUI = { start, showLogin, isActive:()=>active };
})();
