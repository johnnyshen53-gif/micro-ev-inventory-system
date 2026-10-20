// 特惠組合（店長專用）：設定每月的組合內容、期間與組合價。
// 這裡只負責「設定」；組合在銷售結帳與報價單的套用會在下一步加入。
// 原價合計一律用目前的品項售價計算；資料庫儲存時會再檢查一次（組合價必須低於原價合計）。
(function () {
  const $ = id => document.getElementById(id);
  const money = value => `NT$ ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(Number(value) || 0)}`;
  function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  // 台北今天的日期（YYYY-MM-DD），用來判斷組合是否在期間內。
  const taipeiToday = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(now);
  // 期間含頭尾兩天；停用優先。
  function promotionStatus(promotion, today = taipeiToday()) {
    if (!promotion.active) return { key: 'inactive', label: '已停用' };
    if (today < promotion.startsOn) return { key: 'upcoming', label: '尚未開始' };
    if (today > promotion.endsOn) return { key: 'expired', label: '已過期' };
    return { key: 'active', label: '進行中' };
  }
  // 原價合計：各品項目前售價 × 數量。以「分」整數相加，避免小數誤差。找不到的品項回傳 null。
  function listTotal(lines, items) {
    let cents = 0;
    for (const line of lines) {
      const item = items.find(candidate => candidate.id === line.itemId);
      if (!item) return null;
      cents += Math.round(Number(item.price) * 100) * Number(line.quantity);
    }
    return cents / 100;
  }
  function summary(lines, items, comboPrice) {
    const total = listTotal(lines, items);
    const price = comboPrice === '' || comboPrice === null || comboPrice === undefined ? null : Number(comboPrice);
    const discount = total === null || price === null || !Number.isFinite(price) ? null : Math.round((total - price) * 100) / 100;
    const rate = discount === null || !total ? null : discount / total;
    return { total, price, discount, rate, pieces: lines.reduce((sum, line) => sum + Number(line.quantity), 0) };
  }
  // 複製成下個月：期間改成下一個月份的 1 日～月底；名稱開頭的「10 月」改成「11 月」（12 月接 1 月）。
  function nextMonthCopy(promotion) {
    const [year, month] = promotion.startsOn.split('-').map(Number);
    const nextYear = month === 12 ? year + 1 : year, nextMonth = month === 12 ? 1 : month + 1;
    const pad = value => String(value).padStart(2, '0');
    const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
    const name = promotion.name.replace(/^(\d{1,2})(\s*月)/, (_, value, suffix) => `${Number(value) === 12 ? 1 : Number(value) + 1}${suffix}`);
    return { ...promotion, id: '', name, startsOn: `${nextYear}-${pad(nextMonth)}-01`, endsOn: `${nextYear}-${pad(nextMonth)}-${pad(lastDay)}`, active: true,
      items: promotion.items.map(item => ({ ...item })) };
  }
  // 新增組合時的預設期間：本月 1 日～月底。
  function currentMonthRange(today = taipeiToday()) {
    const [year, month] = today.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { startsOn: `${year}-${String(month).padStart(2, '0')}-01`, endsOn: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
  }

  function mount({ getState, notify = () => {} }) {
    if (!$('promo-form')) return { load() {}, clear() {} };
    let promotions = [], draftLines = [], editingId = '', busy = false, generation = 0;
    const isAdmin = () => document.body.dataset?.role === 'admin';
    const items = () => getState().items ?? [];
    const itemName = id => items().find(item => item.id === id)?.name ?? '（品項已刪除）';
    const message = (text, error = false) => { $('promo-status').textContent = text; $('promo-status').classList.toggle('error', error); notify(text, error); };
    const formError = text => { $('promo-form-error').textContent = text; $('promo-form-error').hidden = !text; };

    function renderItemChoices() {
      const select = $('promo-item'), current = select.value;
      select.replaceChildren(new Option('選擇品項', ''));
      for (const item of [...items()].sort((a, b) => a.category.localeCompare(b.category, 'zh-Hant') || a.name.localeCompare(b.name, 'zh-Hant'))) {
        select.append(new Option(`${item.name}（${item.category}｜${money(item.price)}）`, item.id));
      }
      select.value = current;
    }
    function renderDraft() {
      const body = $('promo-lines'); body.replaceChildren();
      draftLines.forEach((line, index) => {
        const item = items().find(candidate => candidate.id === line.itemId);
        const row = element('tr'), action = element('td'), remove = element('button', '移除', 'secondary');
        remove.type = 'button'; remove.dataset.promoRemove = String(index); action.append(remove);
        row.append(element('td', itemName(line.itemId)), element('td', item?.category ?? '—'), element('td', String(line.quantity)),
          element('td', item ? money(Number(item.price) * line.quantity) : '—'), action);
        body.append(row);
      });
      if (!draftLines.length) {
        const row = element('tr'), cell = element('td', '尚未加入品項。請選品項與數量後按「加入」。', 'empty'); cell.colSpan = 5; row.append(cell); body.append(row);
      }
      const result = summary(draftLines, items(), $('promo-price').value);
      const parts = [`原價合計 ${result.total === null ? '—' : money(result.total)}`];
      if (result.discount !== null) parts.push(`讓利 ${money(result.discount)}`, `折扣率 ${result.rate === null ? '—' : `${(result.rate * 100).toFixed(1)}%`}`);
      $('promo-summary').textContent = parts.join('｜');
      $('promo-summary').classList.toggle('warning', result.discount !== null && result.discount <= 0);
    }
    function renderList() {
      const body = $('promo-list'); body.replaceChildren();
      const today = taipeiToday();
      for (const promotion of promotions) {
        const status = promotionStatus(promotion, today), result = summary(promotion.items, items(), promotion.comboPrice);
        const row = element('tr'), actions = element('td'); actions.className = 'actions';
        for (const [label, action, className] of [['編輯', 'edit', 'secondary'], ['複製成下個月', 'copy', 'secondary'], ['刪除', 'delete', 'danger']]) {
          const button = element('button', label, className); button.type = 'button'; button.dataset.promoAction = action; button.dataset.id = promotion.id; actions.append(button);
        }
        const content = promotion.items.map(line => `${itemName(line.itemId)} ×${line.quantity}`).join('、');
        row.append(element('td', promotion.name), element('td', `${promotion.startsOn.replaceAll('-', '/')}～${promotion.endsOn.replaceAll('-', '/')}`),
          element('td', status.label, `promo-state promo-state-${status.key}`), element('td', content),
          element('td', result.total === null ? '—' : money(result.total)), element('td', money(promotion.comboPrice)),
          element('td', result.rate === null ? '—' : `${(result.rate * 100).toFixed(1)}%`),
          element('td', promotion.soldTimes ? `${promotion.soldTimes} 組` : '—'), actions);
        body.append(row);
      }
      if (!promotions.length) {
        const row = element('tr'), cell = element('td', '尚未建立特惠組合。', 'empty'); cell.colSpan = 9; row.append(cell); body.append(row);
      }
    }
    function fillForm(promotion, title) {
      editingId = promotion.id || '';
      $('promo-form-title').textContent = title;
      $('promo-name').value = promotion.name;
      $('promo-starts').value = promotion.startsOn;
      $('promo-ends').value = promotion.endsOn;
      $('promo-price').value = promotion.comboPrice ?? '';
      $('promo-active').checked = promotion.active !== false;
      draftLines = promotion.items.map(item => ({ ...item }));
      $('promo-cancel').hidden = false;
      formError(''); renderItemChoices(); renderDraft();
      $('promo-name').focus();
    }
    function resetForm() {
      editingId = ''; draftLines = [];
      $('promo-form').reset();
      const range = currentMonthRange();
      $('promo-starts').value = range.startsOn; $('promo-ends').value = range.endsOn;
      $('promo-active').checked = true;
      $('promo-form-title').textContent = '新增組合';
      $('promo-cancel').hidden = true;
      formError(''); renderItemChoices(); renderDraft();
    }
    async function refresh() {
      const request = ++generation;
      const loaded = await window.AppData.loadPromotions();
      if (request !== generation || window.AppAuthUI?.isActive?.() === false) return;
      promotions = loaded; renderItemChoices(); renderList(); renderDraft();
    }
    async function run(action, success) {
      if (busy || !isAdmin()) return;
      busy = true;
      try { await action(); await refresh(); message(success); return true; }
      catch (error) { message(error.message, true); return false; }
      finally { busy = false; }
    }

    $('promo-add').addEventListener('click', () => {
      const itemId = $('promo-item').value, quantity = Number($('promo-qty').value);
      if (!itemId) return formError('請先選擇品項。');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return formError('數量須為 1～999 的整數。');
      const existing = draftLines.find(line => line.itemId === itemId);
      if (existing) existing.quantity = Math.min(999, existing.quantity + quantity); else draftLines.push({ itemId, quantity });
      $('promo-qty').value = '1'; $('promo-item').value = ''; formError(''); renderDraft();
    });
    $('promo-lines').addEventListener('click', event => {
      const button = event.target.closest('button[data-promo-remove]');
      if (!button) return;
      draftLines.splice(Number(button.dataset.promoRemove), 1); renderDraft();
    });
    $('promo-price').addEventListener('input', () => { formError(''); renderDraft(); });
    $('promo-cancel').addEventListener('click', resetForm);
    $('promo-form').addEventListener('submit', async event => {
      event.preventDefault();
      const result = summary(draftLines, items(), $('promo-price').value);
      if (!draftLines.length) return formError('請至少加入一個品項。');
      if (result.pieces < 2) return formError('組合至少要有 2 件商品。');
      if (result.price === null || !Number.isFinite(result.price) || result.price < 0) return formError('請填寫組合價。');
      if (result.total !== null && result.price >= result.total) return formError(`組合價須低於目前原價合計 ${money(result.total)}。`);
      formError('');
      const promotion = { id: editingId || null, name: $('promo-name').value, startsOn: $('promo-starts').value, endsOn: $('promo-ends').value,
        comboPrice: result.price, active: $('promo-active').checked, items: draftLines };
      const saved = await run(() => window.AppData.savePromotion(promotion), editingId ? '特惠組合已更新。' : '特惠組合已新增。');
      if (saved) resetForm();
    });
    $('promo-list').addEventListener('click', event => {
      const button = event.target.closest('button[data-promo-action]');
      if (!button) return;
      const promotion = promotions.find(candidate => candidate.id === button.dataset.id);
      if (!promotion) return;
      if (button.dataset.promoAction === 'edit') fillForm(promotion, `編輯：${promotion.name}`);
      else if (button.dataset.promoAction === 'copy') { fillForm(nextMonthCopy(promotion), '新增組合（複製自上個月）'); message('已複製到上方表單，確認期間與組合價後按「儲存組合」。'); }
      else if (button.dataset.promoAction === 'delete' && window.confirm(`確定刪除「${promotion.name}」？已經被使用過的組合請改用「停用」。`)) {
        run(() => window.AppData.deletePromotion(promotion.id), '特惠組合已刪除。').then(done => { if (done && editingId === promotion.id) resetForm(); });
      }
    });
    resetForm();
    return {
      async load() {
        if (!isAdmin()) return;
        try { await refresh(); } catch (error) { message(`無法讀取特惠組合：${error.message}`, true); }
      },
      clear() { generation++; promotions = []; resetForm(); $('promo-list').replaceChildren(); $('promo-status').textContent = ''; },
    };
  }
  // ── 銷售結帳：偵測、挑選、套用組合 ──
  // getCart()：目前購物車（app.js 的 saleCart）；addItem(item, quantity)：加入購物車（失敗會自己顯示錯誤並回傳 false）；
  // onChange()：套用／取消組合後通知結帳畫面重畫（並讓結帳識別碼重新產生，因為送出的內容變了）。
  function mountCheckout({ getState, getCart, addItem, onChange = () => {}, requiresSerial = () => false }) {
    if (!$('sale-promo-panel')) return null;
    let promotions = [], applied = [], generation = 0, loaded = false;
    const inventory = () => window.Inventory;
    const cartLines = () => getCart().map(line => ({ itemId: line.itemId, unitPrice: line.unitPrice, quantity: line.quantity }));
    const inPeriod = promotion => inventory().promotionInPeriod(promotion, taipeiToday());
    const available = () => promotions.filter(inPeriod);
    const resolve = (list = applied) => list.map(entry => ({ promotion: promotions.find(promotion => promotion.id === entry.promotionId), times: entry.times }));
    const withTimes = (id, times) => applied.some(entry => entry.promotionId === id)
      ? applied.map(entry => entry.promotionId === id ? { promotionId: id, times } : entry).filter(entry => entry.times > 0)
      : times > 0 ? [...applied, { promotionId: id, times }] : applied;
    function compute(list = applied) {
      try { return inventory().promotionDiscounts(cartLines(), resolve(list)); }
      catch (error) { return { error: error.message, byItem: new Map(), entries: [], total: 0 }; }
    }
    const hint = (text, error = false) => { $('sale-promo-hint').textContent = text; $('sale-promo-hint').classList.toggle('error', error); };

    // 購物車變動後，把放不下的組數往下調（調到 0 就移除），並回報有沒有變動。
    function reconcile() {
      let next = [], changed = false;
      for (const entry of applied) {
        const promotion = promotions.find(candidate => candidate.id === entry.promotionId);
        let times = promotion && inPeriod(promotion) ? entry.times : 0;
        while (times > 0) {
          const attempt = [...next, { promotionId: entry.promotionId, times }];
          if (!compute(attempt).error) break;
          times--;
        }
        if (times !== entry.times) changed = true;
        if (times > 0) next.push({ promotionId: entry.promotionId, times });
      }
      applied = next;
      return changed;
    }
    // 自動偵測：購物車扣掉已套用的數量後，還能再湊成幾組。
    function suggestions() {
      const base = compute().total;
      return available().flatMap(promotion => {
        const current = applied.find(entry => entry.promotionId === promotion.id)?.times ?? 0;
        const extra = Math.min(99 - current, inventory().promotionFitTimes(cartLines(), resolve(), promotion));
        if (extra < 1) return [];
        const result = compute(withTimes(promotion.id, current + extra));
        return result.error ? [] : [{ promotion, current, extra, saving: Math.round((result.total - base) * 100) / 100 }];
      });
    }
    function render() {
      const list = available();
      $('sale-promo-panel').hidden = !list.length && !applied.length;
      const select = $('sale-promo-select'), selected = select.value;
      select.replaceChildren(new Option(list.length ? '選擇本期組合' : '目前沒有進行中的組合', ''));
      for (const promotion of list) select.append(new Option(`${promotion.name}｜組合價 ${money(promotion.comboPrice)}`, promotion.id));
      select.value = list.some(promotion => promotion.id === selected) ? selected : '';
      $('sale-promo-add').disabled = !select.value;

      const suggestionList = $('sale-promo-suggestions'); suggestionList.replaceChildren();
      for (const { promotion, current, extra, saving } of suggestions()) {
        const item = element('li', '', 'sale-promo-suggestion');
        const label = element('span', `購物車符合「${promotion.name}」，可${current ? '再' : ''}套用 ${extra} 組，省 ${money(saving)}`);
        const button = element('button', '套用'); button.type = 'button';
        button.dataset.promoApply = promotion.id; button.dataset.times = String(current + extra);
        item.append(label, button); suggestionList.append(item);
      }
      suggestionList.hidden = !suggestionList.children.length;

      const appliedList = $('sale-promo-applied'); appliedList.replaceChildren();
      const result = compute();
      for (const entry of result.entries) {
        const item = element('li', '', 'sale-promo-applied-item');
        const label = element('span', `${entry.name} ×${entry.times}`);
        const amount = element('strong', `−${money(entry.discount)}`);
        const button = element('button', '取消', 'secondary'); button.type = 'button'; button.dataset.promoCancel = entry.promotionId;
        button.setAttribute('aria-label', `取消套用 ${entry.name}`);
        item.append(label, amount, button); appliedList.append(item);
      }
      appliedList.hidden = !appliedList.children.length;
    }
    function setTimes(id, times, message) {
      const next = withTimes(id, times), result = compute(next);
      if (result.error) { hint(result.error, true); return false; }
      applied = next; hint(message); onChange(); return true;
    }

    $('sale-promo-select').addEventListener('change', () => { $('sale-promo-add').disabled = !$('sale-promo-select').value; hint(''); });
    // 由組合加入：把組合內的商品一次加進購物車，並直接套用 1 組。
    $('sale-promo-add').addEventListener('click', () => {
      const promotion = promotions.find(candidate => candidate.id === $('sale-promo-select').value);
      if (!promotion || !inPeriod(promotion)) return hint('請選擇進行中的組合。', true);
      const items = getState().items ?? [], cart = getCart();
      const parts = promotion.items.map(part => ({ part, item: items.find(item => item.id === part.itemId) }));
      if (parts.some(({ item }) => !item)) return hint('組合中有品項已刪除，請店長更新組合內容。', true);
      if (parts.some(({ item }) => requiresSerial(item))) return hint('此組合含車身或電池，需要指定序號：請逐一加入購物車，系統會自動提示套用。', true);
      const short = parts.find(({ part, item }) => item.stock - (cart.find(line => line.itemId === item.id)?.quantity ?? 0) < part.quantity);
      if (short) return hint(`庫存不足：${short.item.name}，無法加入這個組合。`, true);
      for (const { part, item } of parts) if (!addItem(item, part.quantity)) return;
      const current = applied.find(entry => entry.promotionId === promotion.id)?.times ?? 0;
      setTimes(promotion.id, current + 1, `已加入「${promotion.name}」並套用組合價。`);
    });
    $('sale-promo-suggestions').addEventListener('click', event => {
      const button = event.target.closest('button[data-promo-apply]');
      if (!button) return;
      const promotion = promotions.find(candidate => candidate.id === button.dataset.promoApply);
      setTimes(button.dataset.promoApply, Number(button.dataset.times), promotion ? `已套用「${promotion.name}」。` : '');
    });
    $('sale-promo-applied').addEventListener('click', event => {
      const button = event.target.closest('button[data-promo-cancel]');
      if (!button) return;
      setTimes(button.dataset.promoCancel, 0, '已取消套用組合，商品仍留在購物車。');
    });

    return {
      async load() {
        const request = ++generation;
        try {
          const list = await window.AppData.loadPromotions();
          if (request !== generation) return;
          promotions = list; loaded = true;
          if (reconcile()) onChange(); else render();
        } catch (error) {
          if (request === generation) hint(`無法讀取特惠組合：${error.message}`, true);
        }
      },
      // 購物車重畫時呼叫：調整放不下的組數並重畫組合區；回傳 true 代表套用內容有變。
      sync() {
        const changed = loaded && reconcile();
        if (changed) hint('購物車數量變動，已自動調整套用的組合。');
        render();
        return changed;
      },
      summary() { const result = compute(); return { discount: result.total, byItem: result.byItem }; },
      // 結帳送出用：[{ promotion, times }]
      selected() { return resolve().filter(entry => entry.promotion); },
      reset() { applied = []; hint(''); render(); },
      clear() { generation++; promotions = []; applied = []; loaded = false; hint(''); render(); },
    };
  }

  window.PromotionUI = { mount, mountCheckout, promotionStatus, listTotal, summary, nextMonthCopy, currentMonthRange, taipeiToday };
})();
