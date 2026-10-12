(() => {
  const { supabaseUrl, supabasePublishableKey } = window.AppConfig ?? {};
  if (!supabaseUrl || !supabasePublishableKey || !window.supabase) throw new Error('Supabase 連線設定無法載入。');
  const storageKey=`sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  const client = window.supabase.createClient(supabaseUrl, supabasePublishableKey,{auth:{storageKey}});

  async function requireActiveUser() {
    const { data: { session } } = await client.auth.getSession();
    if (!session) throw new Error('請先登入。');
    const usernames = window.AppConfig.usernameLoginEnabled === true;
    const { data: profile, error } = await client.from('profiles').select(usernames ? 'id, username, display_name, role, active' : 'id, display_name, role, active').eq('id', session.user.id).maybeSingle();
    if (error || !profile?.active) {
      await client.auth.signOut();
      throw new Error('帳號尚未啟用或已被停用。');
    }
    if (usernames) {
      const check = await client.rpc('current_staff_session_valid');
      if (check.error || !check.data) throw new Error('登入已失效，請重新登入。');
    }
    return { id: profile.id, username: profile.username ?? '', email: usernames ? '' : session.user.email ?? '', displayName: profile.display_name, role: profile.role };
  }

  async function signIn(account, password, isCurrent=()=>true) {
    // Staged cutover: keep the existing gateway until the manager verifies the new login.
    if (!window.AppConfig.usernameLoginEnabled) return client.auth.signInWithPassword({ email: account, password });
    const username = account.trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,32}$/.test(username)) return { error: new Error('請輸入 3–32 字元的登入帳號，不接受 Email。') };
    const { data, error } = await client.functions.invoke('staff-login', { body: { username, password } });
    if(!isCurrent())return {error:new Error('登入已取消。')};
    if (error || data?.error || !data?.accessToken || !data?.refreshToken) return { error: new Error(data?.error || '帳號或密碼不正確，或帳號已停用') };
    return client.auth.setSession({ access_token: data.accessToken, refresh_token: data.refreshToken });
  }

  window.AppAuth = {
    client,
    requireActiveUser,
    signIn,
    signOut: async () => {
      try {return await client.auth.signOut({scope:'local'});}
      finally {
        try {localStorage.removeItem(storageKey);}catch { /* Idle restoration also requires writable storage. */ }
      }
    },
    manageStaff: async (body) => {
      const user = await requireActiveUser();
      if (user.role !== 'admin') throw new Error('僅店長可管理帳號。');
      const { data, error } = await client.functions.invoke('staff-admin', { body });
      if (error || data?.error) throw new Error(data?.error || '帳號操作未完成，請稍後重試。');
      return data;
    },
  };
})();
