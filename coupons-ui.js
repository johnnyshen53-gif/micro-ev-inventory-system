// 優惠代碼（店長專用）：新增、修改、停用、刪除。放在「優惠設定」頁的特惠組合下方。
// 代碼清單只有店長看得到；店員在銷售結帳只能輸入代碼，由資料庫檢查能不能用。
(function () {
  const $ = id => document.getElementById(id);
  const money = value => `NT$ ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(Number(value) || 0)}`;
  function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  const taipeiToday = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(now);
  // 狀態：停用 > 已用完 > 尚未開始／已過期 > 進行中。
  function couponStatus(coupon, today = taipeiToday()) {
    if (!coupon.active) return { key: 'inactive', label: '已停用' };
    if (coupon.usageLimit !== null && coupon.usageLimit !== undefined && coupon.usedCount >= coupon.usageLimit) return { key: 'expired', label: '已用完' };
    if (today < coupon.startsOn) return { key: 'upcoming', label: '尚未開始' };
    if (today > coupon.endsOn) return { key: 'expired', label: '已過期' };
    return { key: 'active', label: '進行中' };
  }
  // 代碼只能用英文字母、數字、- 與 _，3～30 字；一律轉大寫（和資料庫相同）。
  const normalizeCode = value => String(value ?? '').trim().toUpperCase();
  const validCode = code => /^[A-Z0-9_-]{3,30}$/.test(code);
  // 打折的說明文字：10 → 「打 9 折：NT$ 1,000 收 NT$ 900」。
  function valueHint(kind, value) {
    const number = Number(value);
    if (!value || !Number.isFinite(number) || number <= 0) return kind === 'percent' ? '例：輸入 10 ＝ 打 9 折；15 ＝ 打 85 折。' : '例：輸入 500 ＝ 每張單折 500 元（不會折到負數）。';
    if (kind === 'percent') {
      if (number >= 100) return '百分比須小於 100。';
      return `打 ${Math.round((100 - number) * 100) / 1000} 折：NT$ 1,000 收 ${money(1000 - Math.floor(1000 * number / 100))}（折扣捨去到元）。`;
    }
    return `每張單折 ${money(number)}；訂單金額較低時最多折到 0 元。`;
  }

  function mount({ notify = () => {} } = {}) {
    if (!$('coupon-form')) return { load() {}, clear() {} };
    let coupons = [], editingId = '', busy = false, generation = 0;
    const isAdmin = () => document.body.dataset?.role === 'admin';
    const message = (text, error = false) => { $('coupon-status').textContent = text; $('coupon-status').classList.toggle('error', error); notify(text, error); };
    const formError = text => { $('coupon-form-error').textContent = text; $('coupon-form-error').hidden = !text; };
    const label = coupon => window.Inventory.couponLabel(coupon);

    function updateKind() {
      const percent = $('coupon-kind').value === 'percent';
      $('coupon-value-label').textContent = percent ? '折扣百分比（%）' : '折抵金額（NT$）';
      $('coupon-value').max = percent ? '99.99' : '';
      $('coupon-value-hint').textContent = valueHint($('coupon-kind').value, $('coupon-value').value);
    }
    function render() {
      const body = $('coupon-list'); body.replaceChildren();
      const today = taipeiToday();
      for (const coupon of coupons) {
        const status = couponStatus(coupon, today);
        const row = element('tr'), actions = element('td'); actions.className = 'actions';
        for (const [text, action, className] of [['編輯', 'edit', 'secondary'], ['刪除', 'delete', 'danger']]) {
          const button = element('button', text, className); button.type = 'button'; button.dataset.couponAction = action; button.dataset.id = coupon.id; actions.append(button);
        }
        row.append(element('td', coupon.code, 'coupon-code'), element('td', coupon.description || '—'), element('td', label(coupon)),
          element('td', `${coupon.startsOn.replaceAll('-', '/')}～${coupon.endsOn.replaceAll('-', '/')}`),
          element('td', status.label, `promo-state promo-state-${status.key}`),
          element('td', coupon.usageLimit === null ? `${coupon.usedCount} 次（不限）` : `${coupon.usedCount}／${coupon.usageLimit} 次`),
          element('td', coupon.usedDiscount ? money(coupon.usedDiscount) : '—'), actions);
        body.append(row);
      }
      if (!coupons.length) {
        const row = element('tr'), cell = element('td', '尚未建立優惠代碼。', 'empty'); cell.colSpan = 8; row.append(cell); body.append(row);
      }
    }
    function resetForm() {
      editingId = '';
      $('coupon-form').reset();
      const today = taipeiToday(), [year, month] = today.split('-').map(Number);
      $('coupon-starts').value = today;
      $('coupon-ends').value = `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
      $('coupon-active').checked = true;
      $('coupon-form-title').textContent = '新增優惠代碼';
      $('coupon-cancel').hidden = true;
      formError(''); updateKind();
    }
    function fillForm(coupon) {
      editingId = coupon.id;
      $('coupon-form-title').textContent = `編輯：${coupon.code}`;
      $('coupon-code').value = coupon.code;
      $('coupon-description').value = coupon.description ?? '';
      $('coupon-kind').value = coupon.kind;
      $('coupon-value').value = String(coupon.value);
      $('coupon-starts').value = coupon.startsOn;
      $('coupon-ends').value = coupon.endsOn;
      $('coupon-limit').value = coupon.usageLimit === null ? '' : String(coupon.usageLimit);
      $('coupon-active').checked = coupon.active !== false;
      $('coupon-cancel').hidden = false;
      formError(''); updateKind(); $('coupon-code').focus();
    }
    async function refresh() {
      const request = ++generation;
      const loaded = await window.AppData.loadCoupons();
      if (request !== generation || window.AppAuthUI?.isActive?.() === false) return;
      coupons = loaded; render();
    }
    async function run(action, success) {
      if (busy || !isAdmin()) return false;
      busy = true;
      try { await action(); await refresh(); message(success); return true; }
      catch (error) { message(error.message, true); return false; }
      finally { busy = false; }
    }

    $('coupon-kind').addEventListener('change', updateKind);
    $('coupon-value').addEventListener('input', () => { formError(''); updateKind(); });
    $('coupon-cancel').addEventListener('click', resetForm);
    $('coupon-form').addEventListener('submit', async event => {
      event.preventDefault();
      const code = normalizeCode($('coupon-code').value), kind = $('coupon-kind').value, value = Number($('coupon-value').value);
      const limitText = $('coupon-limit').value.trim();
      if (!validCode(code)) return formError('代碼須為 3～30 個英文字母、數字、- 或 _（不分大小寫）。');
      if (!Number.isFinite(value) || value <= 0) return formError('請填寫大於 0 的折扣數值。');
      if (kind === 'percent' && value >= 100) return formError('打折百分比須小於 100。');
      if (limitText && !/^\d+$/.test(limitText)) return formError('使用上限請填整數，或留空表示不限。');
      if ($('coupon-ends').value < $('coupon-starts').value) return formError('結束日不可早於開始日。');
      formError('');
      const coupon = { id: editingId || null, code, description: $('coupon-description').value.trim(), kind, value,
        startsOn: $('coupon-starts').value, endsOn: $('coupon-ends').value, usageLimit: limitText ? Number(limitText) : null, active: $('coupon-active').checked };
      const saved = await run(() => window.AppData.saveCoupon(coupon), editingId ? `優惠代碼 ${code} 已更新。` : `優惠代碼 ${code} 已新增。`);
      if (saved) resetForm();
    });
    $('coupon-list').addEventListener('click', event => {
      const button = event.target.closest('button[data-coupon-action]');
      if (!button) return;
      const coupon = coupons.find(candidate => candidate.id === button.dataset.id);
      if (!coupon) return;
      if (button.dataset.couponAction === 'edit') fillForm(coupon);
      else if (button.dataset.couponAction === 'delete' && window.confirm(`確定刪除優惠代碼「${coupon.code}」？已經用過的代碼請改用「停用」。`)) {
        run(() => window.AppData.deleteCoupon(coupon.id), `優惠代碼 ${coupon.code} 已刪除。`).then(done => { if (done && editingId === coupon.id) resetForm(); });
      }
    });
    resetForm();
    return {
      async load() {
        if (!isAdmin()) return;
        try { await refresh(); } catch (error) { message(`無法讀取優惠代碼：${error.message}`, true); }
      },
      clear() { generation++; coupons = []; resetForm(); $('coupon-list').replaceChildren(); $('coupon-status').textContent = ''; },
    };
  }
  window.CouponUI = { mount, couponStatus, normalizeCode, validCode, valueHint };
})();
