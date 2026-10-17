(() => {
  const $ = id => document.getElementById(id);
  const filterOrders = (orders, term) => orders.filter(order => [order.number, order.customerName, order.customerPhone, order.plateNumber, order.originalSerialNumber]
    .some(value => String(value ?? '').toLocaleLowerCase().includes(String(term ?? '').trim().toLocaleLowerCase())));
  const availableSerials = (serials, itemId) => serials.filter(serial => serial.itemId === itemId && serial.status === 'in_stock');
  const actionState = (order, isAdmin = false) => ({ canEdit: ['intake', 'quoted'].includes(order.status), canQuote: order.status === 'intake',
    canComplete: order.status === 'quoted', canCancel: ['intake', 'quoted'].includes(order.status),
    canPay: order.status === 'completed' && order.paymentStatus === 'unpaid',
    canDelete: isAdmin && ['intake', 'quoted', 'cancelled'].includes(order.status) && order.paymentStatus === 'unpaid' });
  const statusLabel = order => ({ intake: '接修中', quoted: '已報價', completed: '已完工', cancelled: '已取消' })[order.status] ?? order.status;
  const money = value => `NT$ ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(Number(value) || 0)}`;
  function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function printRepairOrder(order, lines, serials = []) {
    const print = $('repair-print');
    print.replaceChildren();
    print.append(element('h1', `維修單 ${order.number}`), element('p', `${statusLabel(order)}｜${order.paymentStatus === 'paid' ? '已收款' : '未收款'}`));
    for (const [label, value] of [
      ['客戶', order.customerName], ['電話', order.customerPhone], ['車牌', order.plateNumber],
      ['原廠序號', order.originalSerialNumber], ['車型', order.vehicleName],
      ['故障／需求', order.issue], ['檢查／處理', order.diagnosis],
    ]) print.append(element('p', `${label}：${value || '—'}`));
    const table = element('table');
    const head = element('tr');
    for (const label of ['用料', '數量', '單價', '小計', '電池原廠序號']) head.append(element('th', label));
    table.append(head);
    for (const line of lines) {
      const row = element('tr');
      for (const value of [line.itemName, line.quantity, money(line.unitPrice), money(line.subtotal),
        serials.filter(serial => serial.repairLineId === line.id).map(serial => serial.serialNumber).join('、') || '—']) row.append(element('td', String(value)));
      table.append(row);
    }
    print.append(table, element('p', `工資：${money(order.laborAmount)}`), element('strong', `總額：${money(order.total)}`));
    document.body.classList.add('printing-repair');
    window.print();
  }

  function mount({ getState, setState, notify }) {
    if (!$('repair-form')) return { load() {}, clear() {} };
    let orders = [], selectedId = '', draftLines = [], busy = false, generation = 0;
    // 維修人員名單（獨立於業務員）。完工前必須指定一位。
    let technicians = [];
    const selectedOrder = () => orders.find(order => order.id === selectedId);
    const state = () => getState();
    const message = (text, error = false) => { $('repair-status').textContent = text; $('repair-status').classList.toggle('error', error); notify(text, error); };
    const repairItems = () => state().items.filter(item => ['零件', '用品', '電池'].includes(item.category));
    function renderPlateChoices(autoFill = false) {
      const plates = state().customers.find(value => value.id === $('repair-customer').value)?.plateNumbers ?? [];
      const choice = $('repair-plate-choice');
      choice.replaceChildren(new Option('請選擇車牌', ''));
      for (const plate of plates) choice.append(new Option(plate, plate));
      $('repair-plate-choice-wrap').hidden = plates.length <= 1;
      if (autoFill) $('repair-plate').value = plates.length === 1 ? plates[0] : '';
      choice.value = plates.includes($('repair-plate').value) ? $('repair-plate').value : '';
    }
    function renderChoices() {
      const customer = $('repair-customer'), item = $('repair-item');
      const oldCustomer = customer.value, oldItem = item.value;
      customer.replaceChildren(new Option('臨時客', ''));
      for (const value of state().customers.filter(value => value.active)) customer.append(new Option(`${value.memberNumber}｜${value.name}｜${value.phone}`, value.id));
      customer.value = state().customers.some(value => value.id === oldCustomer && value.active) ? oldCustomer : '';
      item.replaceChildren(new Option('選擇品項', ''));
      for (const value of repairItems()) item.append(new Option(`${value.name}（庫存 ${value.stock}）`, value.id));
      item.value = repairItems().some(value => value.id === oldItem) ? oldItem : '';
      renderTechnicianChoices();
      renderPlateChoices();
    }
    // 維修人員選單：在職人員；編輯中的維修單若原本的人已停用，仍列出（但完工時資料庫會要求改選在職人員）。
    function renderTechnicianChoices(select = $('repair-technician'), keepId = selectedOrder()?.technicianId ?? '') {
      if (!select) return;
      const old = select.value;
      const people = technicians.filter(person => person.active || person.id === keepId);
      select.replaceChildren(new Option('尚未指定', ''));
      for (const person of people) select.append(new Option(person.active ? person.name : `${person.name}（已停用）`, person.id));
      select.value = people.some(person => person.id === old) ? old : '';
    }
    const technicianName = id => technicians.find(person => person.id === id)?.name ?? '';
    function renderLines() {
      const body = $('repair-lines'); body.replaceChildren();
      draftLines.forEach((line, index) => {
        const row = element('tr');
        for (const value of [line.itemName, line.quantity, money(line.unitPrice), money(line.quantity * line.unitPrice)]) row.append(element('td', String(value)));
        const cell = element('td'), remove = element('button', '移除', 'secondary');
        remove.type = 'button'; remove.dataset.lineIndex = String(index); cell.append(remove); row.append(cell); body.append(row);
      });
    }
    function renderList() {
      const body = $('repair-list'); body.replaceChildren();
      const rows = filterOrders(orders, $('repair-search').value).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      for (const order of rows) {
        const row = element('tr');
        for (const value of [order.number, `${order.customerName}｜${order.customerPhone}`, order.plateNumber || order.originalSerialNumber,
          statusLabel(order), money(order.total)]) row.append(element('td', value));
        const cell = element('td'), open = element('button', '開啟', 'secondary');
        open.type = 'button'; open.dataset.repairId = order.id; cell.append(open); row.append(cell); body.append(row);
      }
      if (!rows.length) {
        const row = element('tr'), cell = element('td', '沒有符合的維修單'); cell.colSpan = 6; row.append(cell); body.append(row);
      }
    }
    function renderDetail() {
      const detail = $('repair-detail'), order = selectedOrder(); detail.replaceChildren(); detail.hidden = !order;
      if (!order) return;
      const actions = actionState(order, document.body.dataset?.role === 'admin');
      detail.append(element('h3', order.number), element('p', `${statusLabel(order)}｜${order.paymentStatus === 'paid' ? '已收款' : '未收款'}｜${money(order.total)}`));
      for (const [label, value] of [['維修人員', technicianName(order.technicianId) || '尚未指定'], ['客戶', `${order.customerName}｜${order.customerPhone}`], ['車牌', order.plateNumber],
        ['原廠序號', order.originalSerialNumber], ['車型', order.vehicleName], ['故障', order.issue], ['檢查／處理', order.diagnosis]])
        detail.append(element('p', `${label}：${value || '—'}`));
      for (const line of order.lines) detail.append(element('p', `${line.itemName} × ${line.quantity}｜${money(line.subtotal)}${state().serials.filter(serial => serial.repairLineId === line.id).map(serial => `｜${serial.serialNumber}`).join('')}`));
      if (actions.canComplete) {
        for (const line of order.lines.filter(line => state().items.find(item => item.id === line.itemId)?.category === '電池')) {
          const label = element('label', `${line.itemName}：選擇 ${line.quantity} 個在庫原廠序號`), select = element('select');
          select.multiple = true; select.size = 5; select.dataset.repairLineId = line.id; select.id = `repair-serial-${line.id}`;
          label.htmlFor = select.id;
          for (const serial of availableSerials(state().serials, line.itemId)) select.append(new Option(serial.serialNumber, serial.id));
          detail.append(label, select);
        }
      }
      for (const [key, label, enabled] of [['complete', '確認完工並扣料', actions.canComplete], ['pay', '標記已收全款', actions.canPay],
        ['cancel', '取消維修單', actions.canCancel], ['delete', '刪除維修單', actions.canDelete], ['print', '列印維修單', true]]) {
        if (!enabled) continue;
        const button = element('button', label, ['cancel', 'delete'].includes(key) ? 'danger' : 'secondary');
        button.type = 'button'; button.dataset.repairAction = key; detail.append(button);
      }
    }
    function resetForm() {
      selectedId = ''; draftLines = []; $('repair-form').reset(); $('repair-form').hidden = false;
      $('repair-form-title').textContent = '新增接修'; $('repair-save').textContent = '儲存接修'; $('repair-quote').hidden = true;
      $('repair-form-error').hidden = true; renderChoices(); renderLines(); renderDetail();
    }
    function openOrder(id) {
      const order = orders.find(value => value.id === id); if (!order) return;
      selectedId = id; draftLines = order.lines.map(line => ({ ...line })); renderChoices();
      for (const [field, value] of [['customer', order.customerId], ['customer-name', order.customerName], ['customer-phone', order.customerPhone],
        ['plate', order.plateNumber], ['original-serial', order.originalSerialNumber], ['vehicle', order.vehicleName],
        ['issue', order.issue], ['diagnosis', order.diagnosis], ['labor', order.laborAmount]]) $(`repair-${field}`).value = value ?? '';
      if ($('repair-technician')) $('repair-technician').value = order.technicianId ?? '';
      renderPlateChoices();
      $('repair-form').hidden = !actionState(order).canEdit;
      $('repair-form-title').textContent = `編輯 ${order.number}`;
      $('repair-save').textContent = order.status === 'quoted' ? '更新報價' : '儲存接修';
      $('repair-quote').hidden = !actionState(order).canQuote;
      renderLines(); renderDetail();
    }
    async function mutation(run, success) {
      if (busy || window.AppAuthUI?.isActive?.() === false) return;
      const request = ++generation;
      busy = true; $('repair-save').disabled = true; $('repair-quote').disabled = true;
      try {
        const result = await run();
        if (request !== generation || window.AppAuthUI?.isActive?.() === false) return;
        orders = result.orders; setState(result.state); renderChoices(); renderList();
        if (result.id) selectedId = result.id;
        if (selectedOrder()) openOrder(selectedId); else resetForm();
        message(success);
      } catch (error) {
        if (request !== generation) return;
        message(`${error.operationCommitted ? '操作可能已成功，但重新讀取失敗；請重新整理後確認。' : ''}${error.message}`, true);
        $('repair-form-error').textContent = error.message; $('repair-form-error').hidden = false;
      } finally {
        if (request === generation) { busy = false; $('repair-save').disabled = false; $('repair-quote').disabled = false; }
      }
    }
    function formOrder(status) {
      const order = { customerId: $('repair-customer').value || null, customerName: $('repair-customer-name').value.trim(),
        customerPhone: $('repair-customer-phone').value.trim(), plateNumber: $('repair-plate').value.trim(),
        originalSerialNumber: $('repair-original-serial').value.trim(), vehicleName: $('repair-vehicle').value.trim(),
        issue: $('repair-issue').value.trim(), diagnosis: $('repair-diagnosis').value.trim(),
        laborAmount: Number($('repair-labor').value), status,
        technicianId: $('repair-technician')?.value || null };
      if (selectedId) order.id = selectedId;
      if (!order.plateNumber && !order.originalSerialNumber) throw new Error('車牌與原廠序號至少填一項。');
      if (!Number.isFinite(order.laborAmount) || order.laborAmount < 0) throw new Error('工資不可為負數。');
      return order;
    }
    function save(status) {
      let order;
      try { order = formOrder(status); } catch (error) { message(error.message, true); return; }
      const expected = selectedOrder()?.updatedAt ?? null;
      mutation(() => window.AppData.saveRepairOrder(order, draftLines.map(line => ({ itemId: line.itemId, quantity: line.quantity, unitPrice: line.unitPrice })), expected), '維修單已儲存；尚未扣庫存。');
    }
    $('repair-new').addEventListener('click', resetForm);
    $('repair-search').addEventListener('input', renderList);
    $('repair-customer').addEventListener('change', () => {
      const customer = state().customers.find(value => value.id === $('repair-customer').value);
      if (customer) { $('repair-customer-name').value = customer.name; $('repair-customer-phone').value = customer.phone; }
      renderPlateChoices(true);
    });
    $('repair-plate-choice').addEventListener('change', () => { $('repair-plate').value = $('repair-plate-choice').value; });
    $('repair-item').addEventListener('change', () => { const item = repairItems().find(value => value.id === $('repair-item').value); $('repair-price').value = item?.price ?? ''; });
    $('repair-add-line').addEventListener('click', () => {
      const item = repairItems().find(value => value.id === $('repair-item').value);
      const quantity = Number($('repair-quantity').value), unitPrice = Number($('repair-price').value);
      if (!item || !Number.isSafeInteger(quantity) || quantity <= 0 || $('repair-price').value.trim() === '' || !Number.isFinite(unitPrice) || unitPrice < 0) { message('請選擇用料，並輸入正確數量與單價。', true); return; }
      draftLines.push({ itemId: item.id, itemName: item.name, quantity, unitPrice }); renderLines();
    });
    $('repair-lines').addEventListener('click', event => { const button = event.target.closest('button[data-line-index]'); if (button) { draftLines.splice(Number(button.dataset.lineIndex), 1); renderLines(); } });
    $('repair-form').addEventListener('submit', event => { event.preventDefault(); save(selectedOrder()?.status ?? 'intake'); });
    $('repair-quote').addEventListener('click', () => { if ($('repair-form').reportValidity()) save('quoted'); });
    $('repair-list').addEventListener('click', event => { const button = event.target.closest('button[data-repair-id]'); if (button) openOrder(button.dataset.repairId); });
    $('repair-detail').addEventListener('click', event => {
      const action = event.target.closest('button[data-repair-action]')?.dataset.repairAction, order = selectedOrder();
      if (!action || !order || busy) return;
      if (action === 'print') { printRepairOrder(order, order.lines, state().serials); return; }
      if (action === 'delete') {
        if (!actionState(order, document.body.dataset?.role === 'admin').canDelete
          || !window.confirm(`確定永久刪除維修單 ${order.number} 與用料明細？此操作無法復原。`)) return;
        mutation(() => window.AppData.deleteRepairOrder(order.id), '維修單已刪除。');
        return;
      }
      if (action === 'cancel' && !window.confirm(`確定取消維修單 ${order.number}？`)) return;
      if (action === 'complete') {
        // 資料庫也會檢查；這裡先擋，避免按了確認才看到錯誤。
        if (!order.technicianId) { message('請先在維修單指定維修人員並儲存，再確認完工。', true); return; }
        if (!window.confirm(`確定將維修單 ${order.number} 標記完工並扣除用料庫存？完成後無法取消。`)) return;
        const selected = {};
        for (const line of order.lines.filter(line => state().items.find(item => item.id === line.itemId)?.category === '電池')) {
          const select = $(`repair-serial-${line.id}`);
          const ids = Array.from(select.selectedOptions, option => option.value);
          if (ids.length !== line.quantity) { message(`${line.itemName} 必須選擇 ${line.quantity} 個在庫序號。`, true); return; }
          selected[line.id] = ids;
        }
        mutation(() => window.AppData.completeRepairOrder(order.id, selected), '維修已完工，庫存與電池保固已更新。');
      } else if (action === 'pay') mutation(() => window.AppData.markRepairPaid(order.id), '已標記全額收款。');
      else if (action === 'cancel') mutation(() => window.AppData.cancelRepairOrder(order.id), '維修單已取消。');
    });
    window.addEventListener('afterprint', () => document.body.classList.remove('printing-repair'));
    resetForm();
    return {
      async load() {
        if (busy) return;
        const request = ++generation;
        try {
          const [loaded, people] = await Promise.all([window.AppData.loadRepairOrders(),
            window.AppData.loadRepairTechnicians ? window.AppData.loadRepairTechnicians() : []]);
          if (request !== generation || window.AppAuthUI?.isActive?.() === false) return;
          orders = loaded; technicians = people; renderChoices(); renderList(); if (selectedOrder()) openOrder(selectedId);
        } catch (error) { if (request === generation) message(`無法讀取維修單：${error.message}`, true); }
      },
      clear() {
        generation++; busy = false; orders = []; technicians = []; selectedId = ''; draftLines = [];
        $('repair-list').replaceChildren(); $('repair-lines').replaceChildren(); $('repair-detail').replaceChildren(); $('repair-detail').hidden = true;
        $('repair-print').replaceChildren(); $('repair-status').textContent = ''; document.body.classList.remove('printing-repair');
      },
    };
  }
  window.RepairUI = { mount, filterOrders, availableSerials, actionState, printRepairOrder };
})();
