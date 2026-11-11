// 庫存清單匯出（CSV，Excel 可直接開）：全部品項，依分類、料號排序。
// 店長匯出含員工價、成本與庫存金額；店員看不到這些，所以不含這三欄。特價、會員價沒設定的品項留空。
(function () {
  const CATEGORY_ORDER = ['車身', '電池', '電控元件', '機構元件', '外觀元件'];

  // CSV 欄位：有逗號、雙引號或換行就用雙引號包起來（裡面的 " 寫成 ""）。
  // 文字開頭是 = + - @ 時前面加 '，避免 Excel 把它當公式執行（數字欄不處理）。
  function cell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return String(value);
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  // state：目前的庫存資料；options：includeCost（是否含成本）、vehicleName(id)、supplierName(id)。
  function inventoryCsv(state, { includeCost = false, vehicleName = () => '', supplierName = () => '' } = {}) {
    const header = ['品名', '分類', '車種', '料號', '條碼', '售價', '特價', '會員價',
      ...(includeCost ? ['員工價', '成本', '庫存金額'] : []),
      '庫存', '單位', '最低庫存', '低庫存', '狀態', '供應商', '保固月數', '電壓（V）', '容量（Ah）', '最後價格異動時間', '備註'];
    // 價格異動時間轉成台灣時間（2026-11-11 14:30）；沒有紀錄留空。
    const priceTime = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16) : '';
    const rank = item => { const index = CATEGORY_ORDER.indexOf(item.category); return index < 0 ? CATEGORY_ORDER.length : index; };
    const items = [...state.items].sort((a, b) => rank(a) - rank(b) || String(a.sku).localeCompare(String(b.sku)) || a.name.localeCompare(b.name, 'zh-Hant'));
    const rows = items.map(item => [
      item.name, item.category, vehicleName(item.vehicleModelId), item.sku, item.barcode, item.price, item.specialPrice ?? '', item.memberPrice ?? '',
      ...(includeCost ? [item.staffPrice ?? '', item.cost, Math.round(item.cost * item.stock * 100) / 100] : []),
      item.stock, item.unit ?? '', item.minimumStock, item.active !== false && item.minimumStock > 0 && item.stock <= item.minimumStock ? '是' : '',
      item.active === false ? '停用' : '啟用', supplierName(item.supplierId), item.warrantyMonths ?? 0,
      item.voltage ?? '', item.capacity ?? '', priceTime(item.priceChangedAt), item.notes,
    ]);
    // 開頭加 BOM（﻿），Windows 版 Excel 才會用 UTF-8 正確顯示中文。
    return '﻿' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  // 檔名：庫存清單_YYYY-MM-DD.csv（台灣日期）。
  function exportFileName(now = new Date()) {
    return `庫存清單_${now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })}.csv`;
  }

  window.InventoryExport = { inventoryCsv, exportFileName, cell };
})();
