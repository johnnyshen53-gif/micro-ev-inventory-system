(() => {
  const key='shop-idle-session-v1',lockKey='shop-idle-session-lock-v1',limit=300000;
  const activity=['pointermove','pointerdown','keydown','wheel','touchstart','scroll'];
  function start({userId,onExpire,fresh=false}) {
    let stopped=false,timer=null,lastSeen=Date.now();
    const read=()=>{const value=localStorage.getItem(key);return value?JSON.parse(value):null;};
    function stop() {
      stopped=true;clearTimeout(timer);
      activity.forEach(event=>document.removeEventListener(event,touch,true));
      document.removeEventListener('visibilitychange',check,true);
      window.removeEventListener('focus',check,true);window.removeEventListener('storage',check,true);
    }
    function expire(reason='idle') {
      if(stopped)return;
      try {sessionStorage.setItem(lockKey,userId);}catch { /* Restoration still requires writable local storage. */ }
      try { const state=read();if(!state||state.userId===userId)localStorage.setItem(key,JSON.stringify({userId,lastActivity:Date.now(),locked:true})); }catch{ /* The UI remains locked even without storage. */ }
      stop();return onExpire(reason);
    }
    function check() {
      if(stopped)return false;
      try {
        const now=Date.now(),state=read();
        if(state?.userId&&state.userId!==userId){expire('changed');return false;}
        if(sessionStorage.getItem(lockKey)===userId||now<lastSeen||!state||state.locked||!Number.isFinite(state.lastActivity)||state.lastActivity>now||now-state.lastActivity>=limit){expire();return false;}
        lastSeen=now;clearTimeout(timer);timer=setTimeout(check,limit-(now-state.lastActivity));return true;
      }catch{expire();return false;}
    }
    function touch(event) {
      if(!check()){event.preventDefault();event.stopImmediatePropagation();return;}
      try {localStorage.setItem(key,JSON.stringify({userId,lastActivity:Date.now(),locked:false}));check();}catch{expire();}
    }
    activity.forEach(event=>document.addEventListener(event,touch,true));
    document.addEventListener('visibilitychange',check,true);window.addEventListener('focus',check,true);window.addEventListener('storage',check,true);
    try {
      if(fresh)sessionStorage.removeItem(lockKey);
      // Restore must prove writes work without extending the previous deadline.
      const value=fresh?JSON.stringify({userId,lastActivity:Date.now(),locked:false}):localStorage.getItem(key);
      if(value)localStorage.setItem(key,value);
    }catch{expire();}
    check();return {stop,lock:()=>expire('manual')};
  }
  window.IdleSession={start};
})();
