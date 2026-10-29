// 批次匯入品項（CSV，店長專用，在「庫存管理」頁）。
// 規則（店長已確認）：
//   只新增：料號留空就自動編碼；填了但已存在（或同一檔案重複）的列標示錯誤，不會覆蓋舊資料。
//   庫存：一般元件可直接帶入；車身／電池需要逐件序號，匯入時庫存必須是 0，之後用進貨收貨登錄序號。
//   售價留空：依「分紅管理」設定的分類加成自動計算（成本 ×（1＋加成%），進位到 10 元）；該分類沒設定加成就必填。
//   車種：必填，填「車種管理」裡啟用中的車種名稱（英文不分大小寫）；全部車款都能用填「通用」。
//   先預覽：每一列都檢查並標示原因，全部正確才能按「確認匯入」，不會只匯一半。
(function () {
  const $ = id => document.getElementById(id);
  const MAX_ROWS = 500;
  // 欄位：標題 → 內部名稱。標題前後空白、結尾的 * 都會忽略。
  const COLUMNS = [
    ['品項名稱', 'name', true], ['分類', 'category', true], ['車種', 'vehicleModel', true], ['料號', 'sku'], ['條碼', 'barcode'], ['成本', 'cost'], ['售價', 'price'],
    ['目前庫存', 'stock'], ['最低庫存', 'minimumStock'], ['保固月數', 'warrantyMonths'], ['供應商', 'supplier'],
    ['電壓', 'voltage'], ['容量', 'capacity'], ['固定售價', 'priceLocked'], ['備註', 'notes'],
  ];
  const CATEGORIES = ['車身', '電池', '電控元件', '機構元件', '外觀元件'];

  // ── CSV 解析（支援雙引號、欄位內逗號與換行、"" 代表一個引號）──
  function parseCsv(text) {
    const rows = []; let row = [], field = '', quoted = false;
    const source = String(text ?? '').replace(/^﻿/, '');
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (quoted) {
        if (char === '"' && source[index + 1] === '"') { field += '"'; index++; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"' && field === '') quoted = true;
      else if (char === ',') { row.push(field); field = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[index + 1] === '\n') index++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += char;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  // 檔案編碼：先試 UTF-8（Mac Excel、Google 試算表），失敗再用 Big5（Windows 中文版 Excel 的「CSV」）。
  function decodeCsv(buffer) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { return new TextDecoder('big5').decode(buffer); }
  }
  // 範本：只有標題列；開頭加 BOM，Excel 打開才不會變亂碼。
  function templateCsv() { return '﻿' + COLUMNS.map(([label, , required]) => label + (required ? '*' : '')).join(',') + '\r\n'; }

  const clean = value => String(value ?? '').trim();
  // 數字欄：允許千分位逗號與空白；空白回傳 null。
  function numberCell(value, label, { integer = false, min = 0, max = Infinity } = {}) {
    const textValue = clean(value).replace(/[,\s]/g, '');
    if (textValue === '') return null;
    if (!/^\d+(\.\d+)?$/.test(textValue)) throw new Error(`${label}必須是數字`);
    const result = Number(textValue);
    if (integer && !Number.isInteger(result)) throw new Error(`${label}必須是整數`);
    if (!integer && Math.round(result * 100) !== result * 100) throw new Error(`${label}最多兩位小數`);
    if (result < min || result > max) throw new Error(`${label}須介於 ${min}～${max}`);
    return result;
  }
  function booleanCell(value) {
    const textValue = clean(value).toUpperCase();
    if (textValue === '') return null;
    if (['是', 'Y', 'YES', 'TRUE', '1', 'V', '✓'].includes(textValue)) return true;
    if (['否', 'N', 'NO', 'FALSE', '0'].includes(textValue)) return false;
    throw new Error('固定售價請填「是」或「否」（或留空）');
  }

  // 把 CSV 內容轉成預覽：每一列的欄位、錯誤、提醒，以及全部成功時的新狀態（nextState）。
  // inventory：window.Inventory；markups：{ 分類: 加成% }。
  function buildPreview(state, text, { inventory, markups = {} }) {
    const table = parseCsv(text).filter(cells => cells.some(cell => clean(cell) !== ''));
    if (!table.length) return { fileError: '檔案是空的，請使用範本填寫後再匯入。', rows: [] };
    const headers = table[0].map(cell => clean(cell).replace(/\*$/, '').trim());
    const indexOf = new Map();
    headers.forEach((header, index) => { const column = COLUMNS.find(([label]) => label === header); if (column && !indexOf.has(column[1])) indexOf.set(column[1], index); });
    // 車種清單還沒載入（例如單元測試的空資料）時不要求車種欄；雲端資料一定有內建的「通用」，實際使用時一律必填。
    const models = state.vehicleModels ?? [];
    const missing = COLUMNS.filter(([, key, required]) => required && (key !== 'vehicleModel' || models.length) && !indexOf.has(key)).map(([label]) => label);
    if (missing.length) return { fileError: `第 1 列必須是標題列，缺少欄位：${missing.join('、')}。請使用範本。`, rows: [] };
    const unknown = headers.filter(header => header && !COLUMNS.some(([label]) => label === header));
    const dataRows = table.slice(1);
    if (!dataRows.length) return { fileError: '只有標題列，沒有要匯入的品項。', rows: [] };
    if (dataRows.length > MAX_ROWS) return { fileError: `一次最多匯入 ${MAX_ROWS} 列，這個檔案有 ${dataRows.length} 列，請分批匯入。`, rows: [] };

    let next = state;
    const usedSkus = new Set(state.items.map(item => item.sku).filter(Boolean));
    const usedBarcodes = new Set(state.items.map(item => item.barcode).filter(Boolean));
    const names = new Set(state.items.map(item => item.name));
    const rows = dataRows.map((cells, offset) => {
      const get = key => indexOf.has(key) ? clean(cells[indexOf.get(key)]) : '';
      const row = { line: offset + 2, name: get('name'), category: get('category'), vehicleModel: get('vehicleModel'), sku: get('sku'), barcode: get('barcode'), errors: [], warnings: [] };
      const fail = message => { row.errors.push(message); return row; };
      try {
        if (!row.name) return fail('品項名稱不可空白');
        if (!CATEGORIES.includes(row.category)) return fail(`分類須為：${CATEGORIES.join('、')}`);
        let vehicleModelId = '';
        if (models.length) {
          if (!row.vehicleModel) return fail('車種不可空白（全部車款都能用請填「通用」）');
          const model = models.find(candidate => candidate.active && candidate.name.toLowerCase() === row.vehicleModel.toLowerCase());
          if (!model) return fail(`找不到啟用中的車種「${row.vehicleModel}」，請先在車種管理新增或啟用`);
          vehicleModelId = model.id; row.vehicleModel = model.name;
        }
        const cost = numberCell(get('cost'), '成本') ?? 0;
        let price = numberCell(get('price'), '售價');
        const stock = numberCell(get('stock'), '目前庫存', { integer: true }) ?? 0;
        const minimumStock = numberCell(get('minimumStock'), '最低庫存', { integer: true }) ?? 0;
        const warrantyMonths = numberCell(get('warrantyMonths'), '保固月數', { integer: true, max: 600 }) ?? 0;
        const voltage = numberCell(get('voltage'), '電壓', { integer: true, min: 1, max: 99 });
        const capacity = numberCell(get('capacity'), '容量', { integer: true, min: 1, max: 99 });
        const lockedCell = booleanCell(get('priceLocked'));
        if (inventory.requiresSerial({ category: row.category }) && stock !== 0) return fail('車身／電池匯入時庫存須為 0，之後請用進貨收貨登錄序號');
        if (row.category === '電池' && (voltage === null || capacity === null)) return fail('電池須填寫電壓與容量（1～99 整數）');
        const markup = markups[row.category];
        const suggested = markup === null || markup === undefined ? null : inventory.suggestedPrice(cost, markup);
        if (price === null) {
          if (suggested === null) return fail(`售價未填，且「${row.category}」尚未設定加成，請填售價`);
          price = suggested; row.priceFromMarkup = true;
        }
        // 固定售價：有填就照填；沒填時，手動售價和加成算出來的不同就視為固定（和手動新增品項相同）。
        const priceLocked = lockedCell ?? (!row.priceFromMarkup && suggested !== null && price !== suggested);
        if (row.sku && usedSkus.has(row.sku)) return fail(`料號「${row.sku}」已存在`);
        if (row.barcode && usedBarcodes.has(row.barcode)) return fail(`條碼「${row.barcode}」已存在`);
        let supplierId = '';
        const supplierName = get('supplier');
        if (supplierName) {
          const supplier = (state.suppliers ?? []).find(candidate => candidate.name === supplierName && candidate.active !== false);
          if (!supplier) return fail(`找不到供應商「${supplierName}」，請先在供應商管理建立`);
          supplierId = supplier.id;
        }
        const before = next.items.length;
        next = inventory.addItem(next, { name: row.name, category: row.category, sku: row.sku, barcode: row.barcode, cost, price, stock, minimumStock,
          warrantyMonths, supplierId, vehicleModelId, voltage, capacity, notes: get('notes'), priceLocked, serialNumbers: [] });
        const created = next.items[before];
        Object.assign(row, { id: created.id, name: created.name, sku: created.sku, barcode: created.barcode, cost, price, stock, priceLocked });
        usedSkus.add(created.sku); if (created.barcode) usedBarcodes.add(created.barcode);
        if (names.has(created.name)) row.warnings.push('已有同名品項');
        names.add(created.name);
      } catch (error) { row.errors.push(error.message); }
      return row;
    });
    const errorCount = rows.filter(row => row.errors.length).length;
    return { rows, errorCount, unknownColumns: unknown, nextState: errorCount ? null : next };
  }

  function mount({ getState, getMarkups, saveState, notify = () => {} }) {
    if (!$('item-import-file')) return { clear() {} };
    let preview = null, fileText = '', fileName = '';
    const money = value => new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(value);
    const status = (text, error = false) => { $('item-import-status').textContent = text; $('item-import-status').classList.toggle('error', error); };
    function render() {
      const body = $('item-import-rows'); body.replaceChildren();
      $('item-import-preview').hidden = !preview?.rows?.length;
      $('item-import-confirm').disabled = !preview?.nextState;
      if (!preview) return;
      for (const row of preview.rows) {
        const tr = document.createElement('tr'); if (row.errors.length) tr.className = 'import-error';
        const cells = [String(row.line), row.name || '—', row.category || '—', row.vehicleModel || '—', row.sku || '（自動）',
          row.cost === undefined ? '—' : money(row.cost), row.price === undefined ? '—' : `${money(row.price)}${row.priceFromMarkup ? '（加成）' : ''}${row.priceLocked ? '（固定）' : ''}`,
          row.stock === undefined ? '—' : money(row.stock), row.errors.length ? row.errors.join('；') : row.warnings.length ? `可匯入（${row.warnings.join('；')}）` : '可匯入'];
        cells.forEach((value, index) => { const td = document.createElement('td'); td.textContent = value; if (index === 8) td.className = row.errors.length ? 'import-state-error' : 'import-state-ok'; tr.append(td); });
        body.append(tr);
      }
    }
    function analyse() {
      if (!fileText) { preview = null; render(); return; }
      preview = buildPreview(getState(), fileText, { inventory: window.Inventory, markups: getMarkups() });
      if (preview.fileError) { status(preview.fileError, true); preview = null; }
      else if (preview.errorCount) status(`${fileName}：共 ${preview.rows.length} 列，${preview.errorCount} 列有錯誤（紅色）。請修正 CSV 後重新選擇檔案；全部正確才能匯入。`, true);
      else status(`${fileName}：共 ${preview.rows.length} 列，全部可以匯入。${preview.unknownColumns.length ? `（已略過不認得的欄位：${preview.unknownColumns.join('、')}）` : ''}確認無誤請按「確認匯入」。`);
      render();
    }
    function reset() { preview = null; fileText = ''; fileName = ''; $('item-import-file').value = ''; status(''); render(); }

    $('item-import-template').addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([templateCsv()], { type: 'text/csv;charset=utf-8' }));
      link.download = '品項匯入範本.csv'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
    $('item-import-file').addEventListener('change', async () => {
      const file = $('item-import-file').files?.[0];
      if (!file) return reset();
      if (file.size > 2 * 1024 * 1024) { reset(); return status('檔案太大（上限 2 MB），請分批匯入。', true); }
      fileName = file.name; fileText = decodeCsv(await file.arrayBuffer());
      analyse();
    });
    $('item-import-cancel').addEventListener('click', reset);
    $('item-import-confirm').addEventListener('click', async () => {
      if (document.body.dataset.role !== 'admin') return status('只有店長可以匯入品項。', true);
      // 按下匯入時再用最新資料檢查一次（避免預覽後有人新增了相同料號）。
      analyse();
      if (!preview?.nextState) return;
      const count = preview.rows.length;
      $('item-import-confirm').disabled = true;
      if (await saveState(preview.nextState)) { reset(); status(`已匯入 ${count} 個品項。`); notify(`已匯入 ${count} 個品項。`); }
      else { $('item-import-confirm').disabled = false; status('匯入沒有完成：請看頁面上方的錯誤訊息，並在品項清單確認是否已有部分品項建立，再重新選擇檔案。', true); }
    });
    render();
    return { clear: reset, refresh() { if (fileText) analyse(); } };
  }

  window.ItemImport = { mount, parseCsv, decodeCsv, templateCsv, buildPreview, COLUMNS };
})();
