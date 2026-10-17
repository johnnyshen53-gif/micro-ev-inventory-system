(() => {
  const $ = id => document.getElementById(id);
  let user=null, callbacks=null, users=[], busy=false, generation=0, request=null;
  const allowed=()=>user?.role==='admin' && window.AppConfig.usernameLoginEnabled;
  function message(text,error=false) { $('staff-message').textContent=text; $('staff-message').className=error?'form-error':''; }
  function selectors() {
    const oldUser=$('staff-existing-user').value,oldPerson=$('staff-existing-person').value;
    $('staff-existing-user').replaceChildren(new Option('選擇雲端帳號',''));
    users.filter(u=>u.active&&u.username).forEach(u=>$('staff-existing-user').append(new Option(`${u.displayName}（${u.username}）`,u.id)));
    for(const id of ['staff-link-person','staff-existing-person']) {
      const el=$(id),value=el.value;el.replaceChildren(new Option(id==='staff-link-person'?'暫不連結本機業務':'選擇本機業務',''));
      callbacks.getSalespeople().forEach(p=>el.append(new Option(p.name,p.id)));el.value=value;
    }
    $('staff-existing-user').value=oldUser;$('staff-existing-person').value=oldPerson;
  }
  function render() {
    const list=$('staff-list');list.replaceChildren();
    for(const u of users) {
      const row=document.createElement('tr');
      [u.displayName,u.username||'尚未設定',u.role==='admin'?'店長':'業務員',u.active?'啟用':'已停用'].forEach(v=>{const cell=document.createElement('td');cell.textContent=v;row.append(cell);});
      const actions=document.createElement('td');actions.className='actions';
      for(const [label,action] of u.active?[['重設密碼','reset-password'],['停用登入','deactivate']]:[]) {
        const b=document.createElement('button');b.type='button';b.className=action==='deactivate'?'danger':'secondary';b.textContent=label;b.dataset.staffAction=action;b.dataset.userId=u.id;actions.append(b);
      }
      row.append(actions);list.append(row);
    }
    selectors();
  }
  async function refresh() {
    if(!allowed())return;
    const token=generation,result=await window.AppAuth.manageStaff({action:'list'});
    if(token!==generation||!allowed())return;
    users=result.users;render();
  }
  async function action(work) {
    if(!allowed()||busy)return;
    busy=true;const token=generation;$('staff-create-submit').disabled=true;
    try { await work(token); }catch(error){if(token===generation)message(error.message,true);}
    finally {busy=false;if(token===generation)$('staff-create-submit').disabled=false;}
  }
  $('staff-create-form')?.addEventListener('submit',event=>{
    event.preventDefault();return action(async token=>{
      const username=$('staff-username').value.trim().toLowerCase();
      const role=$('staff-role').value;
      if(!request||request.username!==username||request.role!==role)request={username,role,requestId:crypto.randomUUID()};
      const personId=$('staff-link-person').value;
      const result=await window.AppAuth.manageStaff({action:'create',...request,displayName:$('staff-name').value,password:$('staff-password').value});
      if(token!==generation)return;
      $('staff-password').value='';request=null;
      users=users.filter(u=>u.id!==result.user.id).concat(result.user);render();
      $('staff-existing-user').value=result.user.id;$('staff-existing-person').value=personId;
      const linked=!personId||await callbacks.link(personId,result.user.id);
      if(token===generation)message(linked?'登入帳號已建立。':'登入帳號已建立，但本機業務連結未完成，請在下方重試連結。',!linked);
    });
  });
  $('staff-link-form')?.addEventListener('submit',event=>{
    event.preventDefault();return action(async token=>{
      const person=$('staff-existing-person').value,id=$('staff-existing-user').value;
      if(!person||!users.some(u=>u.id===id&&u.active))throw new Error('請選擇啟用帳號與本機業務。');
      const linked=await callbacks.link(person,id);
      if(token===generation)message(linked?'本機業務已連結登入帳號。':'連結未完成，請重試。',!linked);
    });
  });
  $('staff-list')?.addEventListener('click',event=>{
    const button=event.target.closest('button[data-staff-action]');if(!button)return;
    if(button.dataset.staffAction==='reset-password') {
      $('staff-reset-user').value=button.dataset.userId;$('staff-reset-panel').hidden=false;$('staff-new-password').value='';$('staff-new-password').focus();return;
    }
    return action(async token=>{
      if(!confirm('確定停用此登入帳號？這會撤銷其工作階段，不會刪除歷史紀錄。'))return;
      await window.AppAuth.manageStaff({action:'deactivate',userId:button.dataset.userId});
      if(token!==generation)return;await refresh();message('登入帳號已停用。');
    });
  });
  $('staff-reset-form')?.addEventListener('submit',event=>{
    event.preventDefault();return action(async token=>{
      if($('staff-new-password').value!==$('staff-confirm-password').value)throw new Error('兩次輸入的密碼不一致。');
      await window.AppAuth.manageStaff({action:'reset-password',userId:$('staff-reset-user').value,password:$('staff-new-password').value});
      if(token!==generation)return;
      $('staff-new-password').value='';$('staff-confirm-password').value='';$('staff-reset-panel').hidden=true;message('密碼已重設，原工作階段已撤銷。');
    });
  });
  $('staff-refresh')?.addEventListener('click',()=>action(refresh));
  window.StaffUI={
    async start(value,options) {generation++;user=value;callbacks=options;users=[];request=null;message('');$('staff-list').replaceChildren();$('staff-panel').hidden=!allowed();const token=generation;if(allowed())refresh().catch(error=>{if(token===generation&&allowed())message(error.message,true);});},
    stop() {generation++;user=null;users=[];request=null;$('staff-panel').hidden=true;$('staff-list').replaceChildren();message('');},
  };
})();
