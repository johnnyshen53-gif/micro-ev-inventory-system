// 分紅管理（店長專用）：設定每台機車獎金、維修分紅百分比、受領名單、適用品項、用料成本確認、維修人員，並查看月份報表。
// 金額一律由資料庫在結帳／完工當下計算與記帳；這個畫面只送出設定、顯示已記帳的快照。
(function () {
  const $ = id => document.getElementById(id);
  const money = value => `NT$ ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(Number(value) || 0)}`;
  function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  // 「未設定」和「0」意義不同：未設定＝不記帳；0＝明確不發。畫面上要清楚分開，避免誤以為已在計算。
  function settingLabel(value, kind) {
    if (value === null || value === undefined) return '未設定：目前不會記帳';
    if (Number(value) === 0) return '已設定為 0：明確不發';
    return kind === 'percent' ? `已啟用：淨額 × ${value}%` : `已啟用：每台 ${money(value)}`;
  }
  // 空白輸入＝未設定（null）；其他須為非負數字，百分比不超過 100。
  function parseSetting(text, kind) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) throw new Error(kind === 'percent' ? '維修分紅百分比須為 0～100 的數字。' : '每台機車獎金須為 0 以上的數字。');
    if (kind === 'percent' && value > 100) throw new Error('維修分紅百分比不可超過 100。');
    return value;
  }
  // 報表個人合計：依「對象＋類別」加總件數與分紅。
  function summarize(rows) {
    const totals = new Map();
    for (const row of rows) {
      const key = `${row.kind}:${row.personId}`;
      const total = totals.get(key) ?? { kind: row.kind, personName: row.personName, count: 0, bonusAmount: 0 };
      total.count += 1; total.bonusAmount = Math.round((total.bonusAmount + row.bonusAmount) * 100) / 100;
      totals.set(key, total);
    }
    return [...totals.values()].sort((a, b) => b.bonusAmount - a.bonusAmount || a.personName.localeCompare(b.personName, 'zh-Hant'));
  }
  const KIND_LABELS = { motorcycle: '機車獎金', repair: '維修分紅' };

  function mount({ getState, notify = () => {} }) {
    if (!$('bonus-settings-form')) return { load() {}, clear() {} };
    let admin = null, busy = false, generation = 0;
    const isAdmin = () => document.body.dataset?.role === 'admin';
    const message = (text, error = false) => { $('bonus-status').textContent = text; $('bonus-status').classList.toggle('error', error); notify(text, error); };

    function checkList(container, options, selectedIds, name) {
      container.replaceChildren();
      if (!options.length) { container.append(element('p', '目前沒有可選項目。', 'hint')); return; }
      for (const option of options) {
        const label = element('label', '', 'check-item'), box = element('input');
        box.type = 'checkbox'; box.name = name; box.value = option.id; box.checked = selectedIds.includes(option.id);
        label.append(box, document.createTextNode(` ${option.label}`)); container.append(label);
      }
    }
    const checkedIds = container => Array.from(container.querySelectorAll?.('input[type="checkbox"]') ?? []).filter(box => box.checked).map(box => box.value);

    function renderSettings() {
      $('bonus-motorcycle-amount').value = admin.motorcycleBonusAmount ?? '';
      $('bonus-repair-percent').value = admin.repairBonusPercent ?? '';
      $('bonus-motorcycle-state').textContent = settingLabel(admin.motorcycleBonusAmount, 'amount');
      $('bonus-repair-state').textContent = settingLabel(admin.repairBonusPercent, 'percent');
      const state = getState();
      const people = (state.salespeople ?? []).filter(person => person.active || admin.recipientIds.includes(person.id))
        .map(person => ({ id: person.id, label: person.active ? person.name : `${person.name}（已停用，不會受領）` }));
      checkList($('bonus-recipients'), people, admin.recipientIds, 'bonus-recipient');
      // 適用品項預設列出「機車」分類，另外保留已勾選的其他品項。
      const items = (state.items ?? []).filter(item => item.category === '機車' || admin.motorcycleItemIds.includes(item.id))
        .map(item => ({ id: item.id, label: `${item.name}（${item.category}）` }));
      checkList($('bonus-items'), items, admin.motorcycleItemIds, 'bonus-item');
    }
    function renderTechnicians() {
      const body = $('bonus-technicians'); body.replaceChildren();
      for (const person of admin.technicians) {
        const row = element('tr'), cell = element('td'), toggle = element('button', person.active ? '停用' : '恢復在職', person.active ? 'danger' : 'secondary');
        toggle.type = 'button'; toggle.dataset.technicianId = person.id; toggle.dataset.technicianActive = String(!person.active);
        cell.append(toggle); row.append(element('td', person.name), element('td', person.active ? '在職' : '已停用'), cell); body.append(row);
      }
      if (!admin.technicians.length) { const row = element('tr'), cell = element('td', '尚未建立維修人員'); cell.colSpan = 3; row.append(cell); body.append(row); }
    }
    function renderCosts() {
      const body = $('bonus-costs'); body.replaceChildren();
      const pending = admin.partCosts.filter(row => !row.confirmed).length;
      $('bonus-costs-summary').textContent = pending ? `尚有 ${pending} 個用料品項成本未確認。` : '所有用料品項成本皆已確認。';
      for (const row of admin.partCosts) {
        const tr = element('tr'), cell = element('td'), button = element('button', row.confirmed ? '取消確認' : '確認成本', row.confirmed ? 'secondary' : '');
        button.type = 'button'; button.dataset.costItemId = row.itemId; button.dataset.costConfirmed = String(!row.confirmed);
        cell.append(button);
        tr.append(element('td', row.name), element('td', row.category), element('td', row.cost === null ? '未建立' : money(row.cost)),
          element('td', row.confirmed ? '已確認' : '未確認', row.confirmed ? '' : 'warning'), cell);
        body.append(tr);
      }
    }
    async function renderReport() {
      const month = $('bonus-month').value;
      const summary = $('bonus-summary'), detail = $('bonus-detail');
      if (!month) return;
      const request = generation;
      const rows = await window.AppData.loadMonthlyBonusReport(month);
      if (request !== generation) return;
      summary.replaceChildren(); detail.replaceChildren();
      for (const total of summarize(rows)) {
        const tr = element('tr');
        tr.append(element('td', total.personName), element('td', KIND_LABELS[total.kind] ?? total.kind), element('td', String(total.count)), element('td', money(total.bonusAmount)));
        summary.append(tr);
      }
      for (const row of rows) {
        const tr = element('tr');
        tr.append(element('td', new Date(row.occurredAt).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })), element('td', KIND_LABELS[row.kind] ?? row.kind),
          element('td', row.personName), element('td', row.sourceNumber), element('td', money(row.baseAmount)), element('td', money(row.bonusAmount)));
        detail.append(tr);
      }
      for (const body of [summary, detail]) if (!body.children.length) {
        const tr = element('tr'), cell = element('td', '本月沒有分紅紀錄'); cell.colSpan = body === summary ? 4 : 6; tr.append(cell); body.append(tr);
      }
    }
    async function refresh() {
      admin = await window.AppData.loadBonusAdminState();
      renderSettings(); renderTechnicians(); renderCosts();
      await renderReport();
    }
    async function run(action, success) {
      if (busy || !isAdmin()) return;
      busy = true;
      try { await action(); await refresh(); message(success); }
      catch (error) { message(error.message, true); }
      finally { busy = false; }
    }

    $('bonus-settings-form').addEventListener('submit', event => {
      event.preventDefault();
      let settings;
      try {
        settings = { motorcycleBonusAmount: parseSetting($('bonus-motorcycle-amount').value, 'amount'),
          repairBonusPercent: parseSetting($('bonus-repair-percent').value, 'percent'),
          recipientIds: checkedIds($('bonus-recipients')), motorcycleItemIds: checkedIds($('bonus-items')) };
      } catch (error) { message(error.message, true); return; }
      run(() => window.AppData.saveBonusSettings(settings), '分紅設定已儲存；只影響之後的結帳與完工。');
    });
    $('bonus-technician-form').addEventListener('submit', event => {
      event.preventDefault();
      const name = $('bonus-technician-name').value.trim();
      if (!name) { message('請填維修人員姓名。', true); return; }
      run(async () => { await window.AppData.saveRepairTechnician({ name, active: true }); $('bonus-technician-name').value = ''; }, '已新增維修人員。');
    });
    $('bonus-technicians').addEventListener('click', event => {
      const button = event.target.closest('button[data-technician-id]');
      const person = admin?.technicians.find(value => value.id === button?.dataset.technicianId);
      if (!person) return;
      const active = button.dataset.technicianActive === 'true';
      run(() => window.AppData.saveRepairTechnician({ id: person.id, name: person.name, active }), active ? '維修人員已恢復在職。' : '維修人員已停用。');
    });
    $('bonus-costs').addEventListener('click', event => {
      const button = event.target.closest('button[data-cost-item-id]');
      if (!button) return;
      const confirmed = button.dataset.costConfirmed === 'true';
      run(() => window.AppData.setItemCostsConfirmed([button.dataset.costItemId], confirmed), confirmed ? '成本已確認。' : '已取消成本確認。');
    });
    $('bonus-month').addEventListener('change', () => { if (isAdmin()) renderReport().catch(error => message(`無法讀取分紅報表：${error.message}`, true)); });

    return {
      async load() {
        // 一般員工不呼叫任何分紅 RPC（資料庫也會拒絕）。
        if (!isAdmin() || busy) return;
        const request = ++generation;
        if (!$('bonus-month').value) $('bonus-month').value = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 7);
        try { await refresh(); }
        catch (error) { if (request === generation) message(`無法讀取分紅資料：${error.message}`, true); }
      },
      clear() {
        generation++; busy = false; admin = null;
        for (const id of ['bonus-recipients', 'bonus-items', 'bonus-technicians', 'bonus-costs', 'bonus-summary', 'bonus-detail']) $(id).replaceChildren();
        for (const id of ['bonus-status', 'bonus-motorcycle-state', 'bonus-repair-state', 'bonus-costs-summary']) $(id).textContent = '';
        $('bonus-motorcycle-amount').value = ''; $('bonus-repair-percent').value = '';
      },
    };
  }
  window.BonusUI = { mount, settingLabel, parseSetting, summarize };
})();
