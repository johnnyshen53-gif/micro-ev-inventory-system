(() => {
const {
  requiresSerial, registerSerials,
  addSupplier, updateSupplier, deactivateSupplier,
  createPurchase, updatePurchase, deletePurchase, receivePurchase, markPurchasePaid,
  addCustomer,
  addItem,
  addSalesperson,
  addWarrantyCase,
  createQuotation,
  createWarranty,
  dashboardSummary,
  deactivateCustomer,
  deactivateSalesperson,
  deleteCustomer,
  deleteItem,
  deleteWarranty,
  deleteWarrantyCase,
  emptyState,
  inventoryCost,
  recordSale,
  recordSaleBatch,
  recordTransaction,
  salesForMonth,
  toBackup,
  updateCustomer,
  updateSalesperson,
  updateItem,
  updateWarranty,
  updateWarrantyCase,
  validateState,
  warrantiesForFilter,
} = window.Inventory;
// 售價加成 { 分類: 百分比 }（店長進入庫存管理時從雲端讀取）。放在開頭宣告，避免其他函式提早使用時尚未初始化。
let priceMarkups = {};

const { InventoryStorage } = window;
const $ = (id) => document.getElementById(id);
let state = emptyState();
let quotationLines = [];
let hourlyRate = 0;
let saleCart = [];
// 這次結帳的固定識別碼：購物車內容不變時重按結帳會沿用，雲端據此避免重複銷售。
let saleCheckoutId = '';
let saleSerialItemId = '';
let saleSerialQuantity = 1;
let selectedWarrantyId = '';
let currentUser = null;
let appSessionEpoch = 0;
let pendingSave = null;
let receiptPurchaseId = '';
let receiptSerialNumbersByItem = {};
let manageApproved = false;
const mobileAllowedPages = new Set(['monthly-sales']);
function isMobileView() { return window.matchMedia?.('(max-width: 700px)')?.matches === true; }

function setAppEnabled(enabled) {
  document.querySelectorAll('#app-shell button, #app-shell input, #app-shell select, #app-shell textarea').forEach((element) => { element.disabled = !enabled; });
  if (enabled && $('sale-category')) renderSalePicker();
  if (enabled && $('sale-serial-panel')) renderSaleSerialSelector(state.items.find(item => item.id === saleSerialItemId));
  if (enabled && $('item-category')) updateBatteryFields();
  if (enabled && $('warranty-serial')) renderWarrantySerials();
  if (enabled && $('transaction-warranty')) renderTransactionWarranty();
}

setAppEnabled(false);

function showPage(page) {
  if (isMobileView() && !mobileAllowedPages.has(page)) page = 'monthly-sales';
  if (document.querySelector(`[data-page-target="${page}"]`)?.dataset.cloudDisabled !== undefined) page = 'list';
  if (page === 'manage' && !manageApproved) {
    openManageAuth();
    page = 'list';
  } else if (page === 'manage') manageApproved = false;
  const section = document.querySelector(`.app-page[data-page="${page}"]`);
  if (section?.dataset.role === 'admin' && document.body.dataset.role !== 'admin') page = 'sales';
  document.querySelectorAll('.app-page[data-page]').forEach((section) => {
    section.hidden = section.dataset.page !== page;
  });
  document.querySelectorAll('[data-page-target]').forEach((button) => {
    const current = button.dataset.pageTarget === page;
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (page === 'monthly-sales') renderMonthlySales(true);
  if (page === 'repairs') window.RepairUI?.instance?.load();
  if (page === 'bonus') window.BonusUI?.instance?.load();
  if (page === 'promotions') window.PromotionUI?.instance?.load();
  if (page === 'sales') window.PromotionUI?.checkout?.load();
  if (page === 'quotations') window.PromotionUI?.quotation?.load();
  if (page === 'manage') loadPriceMarkups();
}

function currentPage() {
  const page = location.hash.slice(1);
  if (isMobileView() && !mobileAllowedPages.has(page)) return 'monthly-sales';
  return document.querySelector(`[data-page-target="${page}"]`)?.dataset.cloudDisabled === undefined && document.querySelector(`.app-page[data-page="${page}"]`) ? page : 'list';
}


function setStatus(message, error = false, moveFocus = false) {
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('error', error);
  status.setAttribute('role', error ? 'alert' : 'status');
  if (moveFocus) status.focus();
}

function clearFormError(formId) {
  const error = $(`${formId}-error`);
  error.textContent = '';
  error.hidden = true;
}

function showFormError(formId, message) {
  const error = $(`${formId}-error`);
  error.textContent = message;
  error.hidden = false;
  setStatus(message, true, true);
}

if (window.RepairUI) window.RepairUI.instance = window.RepairUI.mount({
  getState: () => state,
  setState: next => { state = next; render(); },
  notify: setStatus,
  // 全店工時費率（店長在分紅管理設定）供維修單依工時自動算工資。
  getHourlyRate: () => hourlyRate,
});
// 分紅管理（店長專用）：業務員與品項名單取自目前狀態，金額設定與紀錄另由店長專用 RPC 讀取。
if (window.BonusUI) window.BonusUI.instance = window.BonusUI.mount({ getState: () => state, notify: setStatus });
// 特惠組合頁有自己的狀態列，不再重複顯示在頁首。
if (window.PromotionUI) window.PromotionUI.instance = window.PromotionUI.mount({ getState: () => state });
// 銷售結帳的特惠組合：自動偵測、由組合加入、套用／取消。套用內容一變，結帳識別碼就重新產生（送出的內容不同了）。
if (window.PromotionUI) window.PromotionUI.checkout = window.PromotionUI.mountCheckout({
  getState: () => state,
  getCart: () => saleCart,
  addItem: (item, quantity) => addSaleItem(item, quantity),
  onChange: () => { saleCheckoutId = ''; renderSaleCart(); },
  requiresSerial,
});
// 報價單的特惠組合：同一套規則；報價不扣庫存，所以不檢查庫存、也不需要序號。
if (window.PromotionUI) window.PromotionUI.quotation = window.PromotionUI.mountCheckout({
  prefix: 'quotation-promo', noun: '報價明細', checkStock: false,
  getState: () => state,
  getCart: () => quotationLines,
  addItem: (item, quantity) => addQuotationItem(item, quantity),
  onChange: () => renderQuotationBuilder(),
});

async function saveState(nextState) {
  if (window.AppAuthUI.isActive?.() === false) return false;
  const epoch = appSessionEpoch;
  setAppEnabled(false);
  try {
    pendingSave = window.AppData?.saveSnapshot ? window.AppData.saveSnapshot(state, nextState) : InventoryStorage.saveState(nextState);
    const validState = await pendingSave;
    if (epoch !== appSessionEpoch) return false;
    state = validState;
    return true;
  } catch (error) {
    // 雲端已重新讀取時，以雲端為準更新畫面，避免顯示過期的庫存或漏掉已完成的銷售。
    if (error.reloadedState && epoch === appSessionEpoch) { state = error.reloadedState; render(); }
    setStatus(`無法儲存資料：${error.message}`, true);
    return false;
  } finally {
    pendingSave = null;
    setAppEnabled(window.AppAuthUI.isActive?.() !== false);
  }
}

function itemName(itemId) {
  return state.items.find((item) => item.id === itemId)?.name ?? '已刪除品項';
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(value);
}

function appendEmpty(list, message) {
  const entry = document.createElement('li');
  entry.className = 'empty';
  entry.textContent = message;
  list.append(entry);
}

function renderSummary() {
  const lowStock = state.items.filter((item) => item.stock <= item.minimumStock);
  $('item-count').textContent = String(state.items.length);
  $('stock-count').textContent = String(state.items.reduce((sum, item) => sum + item.stock, 0));
  $('low-stock-count').textContent = String(lowStock.length);
  $('inventory-cost').textContent = `NT$ ${formatNumber(inventoryCost(state))}`;

  const lowList = $('low-stock-list');
  lowList.replaceChildren();
  if (!lowStock.length) appendEmpty(lowList, '目前沒有低庫存品項。');
  lowStock.forEach((item) => {
    const entry = document.createElement('li');
    entry.textContent = `${item.name}：剩 ${formatNumber(item.stock)}（最低 ${formatNumber(item.minimumStock)}）`;
    lowList.append(entry);
  });

  const recent = $('recent-transactions');
  recent.replaceChildren();
  const typeLabel = { in: '進貨', out: '售出', adjust: '盤點調整', warranty_out: '出保固' };
  const transactions = [...state.transactions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
  if (!transactions.length) appendEmpty(recent, '尚未有庫存異動。');
  transactions.forEach((transaction) => {
    const entry = document.createElement('li');
    entry.textContent = `${itemName(transaction.itemId)}｜${typeLabel[transaction.type]} ${formatNumber(transaction.quantity)}｜${new Date(transaction.createdAt).toLocaleString('zh-TW')}`;
    recent.append(entry);
  });
}

// 品項庫存依分類檢視：上方分類按鈕（全部／車身／電池／電控元件／機構元件／外觀元件），顯示各分類品項數與低庫存數。
const ITEM_CATEGORIES = ['車身', '電池', '電控元件', '機構元件', '外觀元件'];
let itemCategoryFilter = '';
function renderItemCategoryTabs() {
  const tabs = $('item-category-tabs'); if (!tabs) return;
  tabs.replaceChildren();
  [['', '全部'], ...ITEM_CATEGORIES.map(category => [category, category])].forEach(([value, label]) => {
    const inCategory = state.items.filter(item => !value || item.category === value);
    const low = inCategory.filter(item => item.stock <= item.minimumStock).length;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'category-tab'; button.dataset.category = value;
    button.setAttribute('aria-pressed', String(value === itemCategoryFilter));
    button.textContent = `${label}（${inCategory.length}）`;
    if (low) { const badge = document.createElement('span'); badge.className = 'category-tab-low'; badge.textContent = `低庫存 ${low}`; button.append(badge); }
    tabs.append(button);
  });
}
function renderItems() {
  renderItemCategoryTabs();
  const query = $('item-search').value.trim().toLowerCase();
  const items = state.items.filter((item) => (!itemCategoryFilter || item.category === itemCategoryFilter) && [item.name, item.sku, item.barcode, item.category].some((value) => value.toLowerCase().includes(query)));
  const list = $('item-list');
  list.replaceChildren();
  if (!items.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 9;
    cell.className = 'empty';
    cell.textContent = query ? '沒有符合搜尋條件的品項。' : itemCategoryFilter ? `「${itemCategoryFilter}」分類目前沒有品項。` : '尚未建立品項。';
    row.append(cell);
    list.append(row);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('tr');
    [item.name, item.category, item.sku || '—', item.barcode || '—', `NT$ ${formatNumber(item.price)}`, formatNumber(item.stock), formatNumber(item.minimumStock), supplierName(item.supplierId)].forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      // 低庫存不只靠橘色：再加「低庫存」文字標籤，色弱或黑白列印也看得出來。
      if (index === 5 && item.stock <= item.minimumStock) { cell.className = 'low'; const badge = document.createElement('small'); badge.className = 'low-badge'; badge.textContent = '低庫存'; cell.append(badge); }
      row.append(cell);
    });
    const actions = document.createElement('td');
    actions.className = 'actions';
    for (const [label, action, className] of document.body.dataset.role === 'admin' ? [['編輯', 'edit', 'secondary'], ['刪除', 'delete', 'danger']] : []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.className = className;
      button.dataset.action = action;
      button.dataset.id = item.id;
      actions.append(button);
    }
    if (/^\d{13}$/.test(item.barcode)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '列印 QR Code';
      button.className = 'secondary';
      button.dataset.action = 'print-qr';
      button.dataset.id = item.id;
      actions.append(button);
    }
    row.append(actions);
    list.append(row);
  });
}

function renderTransactionItems() {
  const select = $('transaction-item');
  const selected = select.value;
  select.replaceChildren();
  if (!state.items.length) {
    const option = new Option('請先新增品項', '');
    select.append(option);
    select.disabled = true;
    $('transaction-form').querySelector('button').disabled = true;
    return;
  }
  select.disabled = false;
  $('transaction-form').querySelector('button').disabled = false;
  state.items.forEach((item) => select.append(new Option(`${item.name}（庫存 ${formatNumber(item.stock)}）`, item.id)));
  if (state.items.some((item) => item.id === selected)) select.value = selected;
}

function render() {
  if ($('supplier-list')) renderSuppliers();
  if ($('item-supplier')) renderItemSuppliers();
  if ($('purchase-list')) { renderPurchaseBuilder(); renderPurchases(); renderPurchaseDetail(); }
  if ($('item-count')) renderSummary();
  if ($('item-list')) renderItems();
  if ($('transaction-item')) renderTransactionItems();
  if ($('customer-list')) renderCustomers();
  if ($('salesperson-list')) renderSalespeople();
  if ($('quotation-customer')) renderQuotationBuilder();
  if ($('quotation-list')) renderQuotations();
  if ($('sale-customer')) renderSaleCustomers();
  if ($('sale-salesperson')) renderSaleSalespeople();
  if ($('sale-category')) renderSalePicker();
  if ($('serial-item')) renderSerialInventory();
  if ($('transaction-serial-fields')) renderTransactionSerials();
  if ($('transaction-warranty')) renderTransactionWarranty();
  if ($('warranty-list')) renderWarranties();
  if ($('monthly-sales-list')) renderMonthlySales();
}

function itemFields() {
  return {
    name: $('item-name').value,
    category: $('item-category').value,
    supplierId: $('item-supplier').value,
    voltage: $('item-voltage').value,
    capacity: $('item-capacity').value,
    sku: $('item-sku').value,
    barcode: $('item-barcode').value,
    cost: $('item-cost').value,
    price: $('item-price').value,
    stock: $('item-stock').value,
    minimumStock: $('item-minimum-stock').value,
    warrantyMonths: $('item-warranty-months').value,
    notes: $('item-notes').value,
    priceLocked: Boolean($('item-price-locked')?.checked),
    serialNumbers: serialNumbersFromInput($('item-serial-numbers')?.value || ''),
    createdBy: currentUser?.id,
  };
}

function resetItemForm() {
  $('item-form').reset();
  $('item-id').value = '';
  renderItemSuppliers();
  $('item-category').value = '電控元件';
  updateBatteryFields();
  $('item-cost').value = '0';
  $('item-price').value = '0';
  $('item-stock').value = '0';
  $('item-minimum-stock').value = '0';
  $('item-warranty-months').value = '0';
  if ($('item-price-locked')) $('item-price-locked').checked = false;
  updateSuggestedPrice(false);
  $('item-form-title').textContent = '新增品項';
  $('item-cancel').hidden = true;
  updateItemPrintButton();
}

function updateItemPrintButton() {
  const button = $('item-print-qr');
  if (button) button.disabled = !$('item-name').value.trim() || !/^\d{13}$/.test($('item-barcode').value.trim());
}

function startEditing(item) {
  if (currentPage() !== 'manage') location.hash = 'manage';
  $('item-id').value = item.id;
  renderItemSuppliers();
  $('item-supplier').value = item.supplierId;
  Object.entries(item).forEach(([key, value]) => {
    const input = $(`item-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
    if (input) input.value = value;
  });
  if ($('item-price-locked')) $('item-price-locked').checked = item.priceLocked === true;
  $('item-form-title').textContent = `編輯：${item.name}`;
  updateBatteryFields();
  updateSuggestedPrice(false);
  $('item-cancel').hidden = false;
  updateItemPrintButton();
  $('item-name').focus();
}

if ($('item-form')) $('item-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (document.body.dataset.role !== 'admin') return showFormError('item-form', '只有管理員可以修改品項。');
  try {
    const id = $('item-id').value;
    const next = id ? updateItem(state, id, itemFields()) : addItem(state, itemFields());
    if (!await saveState(next)) return;
    resetItemForm();
    clearFormError('item-form');
    render();
    setStatus(id ? '品項已更新。' : '品項已新增。');
  } catch (error) {
    showFormError('item-form', error.message);
  }
});

$('item-cancel')?.addEventListener('click', resetItemForm);
function updateBatteryFields() {
  const isBattery = $('item-category').value === '電池';
  $('battery-fields').hidden = !isBattery;
  for (const id of ['item-voltage', 'item-capacity']) $(id).required = isBattery;
  if ($('item-serial-fields')) $('item-serial-fields').hidden = !requiresSerial({ category: $('item-category').value }) || Boolean($('item-id').value);
  $('item-stock').readOnly = Boolean($('item-id').value) && requiresSerial(state.items.find(item => item.id === $('item-id').value));
}
$('item-category').addEventListener('change', updateBatteryFields);

// 售價加成：在「分紅管理」設定各分類的加成 %。輸入成本或換分類時自動帶入售價（無條件進位到 10 元）；
// 手動改過售價就自動勾「固定售價」，之後進貨收貨也不會被重算。（priceMarkups 宣告在檔案開頭）
async function loadPriceMarkups() {
  if (document.body.dataset.role !== 'admin' || !window.AppData?.loadPriceMarkups) return;
  try { priceMarkups = await window.AppData.loadPriceMarkups() ?? {}; } catch { priceMarkups = {}; }
  updateSuggestedPrice(false);
}
function currentSuggestedPrice() {
  const percent = priceMarkups[$('item-category')?.value];
  return percent === undefined ? null : window.Inventory.suggestedPrice($('item-cost').value, percent);
}
function updateSuggestedPrice(apply = true) {
  const hint = $('item-price-hint');
  if (!hint) return;
  const category = $('item-category').value, percent = priceMarkups[category];
  if (percent === undefined) { hint.textContent = `「${category}」未設定售價加成（可在「分紅管理」設定）。`; return; }
  const suggested = currentSuggestedPrice();
  if ($('item-price-locked').checked) {
    hint.textContent = `固定售價：不會自動重算${suggested === null ? '' : `（依加成 ${percent}% 建議 NT$ ${formatNumber(suggested)}）`}。`;
    return;
  }
  if (apply && suggested !== null) $('item-price').value = String(suggested);
  hint.textContent = `售價依「${category}」加成 ${percent}% 自動計算（無條件進位到 10 元）；進貨收貨時也會重算。`;
}
if ($('item-price-hint')) {
  $('item-category').addEventListener('change', () => updateSuggestedPrice(true));
  $('item-cost').addEventListener('input', () => updateSuggestedPrice(true));
  $('item-price').addEventListener('input', () => {
    const suggested = currentSuggestedPrice();
    if (suggested === null || $('item-price-locked').checked || Number($('item-price').value) === suggested) return;
    $('item-price-locked').checked = true;
    updateSuggestedPrice(false);
    $('item-price-hint').textContent = '已手動修改售價，已自動勾選「固定售價」；取消勾選即可恢復自動計算。';
  });
  $('item-price-locked').addEventListener('change', () => updateSuggestedPrice(!$('item-price-locked').checked));
}
function parseUnitQr(value) {
  const raw = String(value || '').trim();
  const [barcode, serialNumber, extra] = raw.split('|');
  return barcode && serialNumber && !extra && /^\d{13}$/.test(barcode) ? { barcode, serialNumber: serialNumber.trim() } : { barcode: raw, serialNumber: '' };
}
$('item-search')?.addEventListener('input', renderItems);
$('item-category-tabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-category]');
  if (!button) return;
  itemCategoryFilter = button.dataset.category;
  renderItems();
});
$('item-search')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const barcode = event.currentTarget.value.trim();
  if (!barcode) return;
  event.preventDefault();
  if (!state.items.some((item) => item.barcode === barcode)) return setStatus('找不到此條碼的品項。', true, true);
  renderItems();
  setStatus('已找到對應品項。');
});
$('item-name')?.addEventListener('input', updateItemPrintButton);
$('item-barcode')?.addEventListener('input', updateItemPrintButton);
$('item-print-qr')?.addEventListener('click', () => showQrLabel({ name: $('item-name').value.trim(), sku: $('item-sku').value.trim(), barcode: $('item-barcode').value.trim() }));

function handleTransactionScan(decodedText) {
  const scan = parseUnitQr(decodedText);
  const item = state.items.find((candidate) => candidate.barcode === scan.barcode);
  if (!item) {
    $('transaction-scan-result').hidden = true;
    showFormError('transaction-form', scan.barcode ? '找不到此條碼的品項。' : '請先掃描或輸入條碼。');
    return false;
  }
  $('transaction-item').value = item.id;
  renderTransactionSerials();
  clearFormError('transaction-form');
  if (scan.serialNumber) selectTransactionSerial(scan.serialNumber);
  $('transaction-barcode').value = '';
  showScannedItem(item);
  if (!$('transaction-form-error').hidden) return false;
  $('transaction-quantity').focus();
  setStatus(`已選取：${item.name}。請輸入數量。`);
  return true;
}
$('transaction-barcode')?.addEventListener('keydown', (event) => { if (event.key !== 'Enter') return; event.preventDefault(); handleTransactionScan(event.currentTarget.value); });

function selectTransactionSerial(serialNumber) {
  const type = $('transaction-type').value;
  if (type === 'in') {
    const input = $('transaction-serial-numbers');
    const serials = serialNumbersFromInput(input.value);
    if (!serials.includes(serialNumber)) input.value = [...serials, serialNumber].join('\n');
    return;
  }
  const select = $('transaction-serial-ids');
  const serial = state.serials.find((entry) => entry.itemId === $('transaction-item').value && entry.serialNumber === serialNumber && entry.status === 'in_stock');
  const option = Array.from(select.options).find((entry) => entry.value === serial?.id);
  if (!option) return showFormError('transaction-form', '找不到此品項可移出的在庫原廠序號。');
  option.selected = true;
}

function showScannedItem(item) {
  const result = $('transaction-scan-result');
  result.replaceChildren();
  const name = document.createElement('strong');
  name.textContent = item.name;
  const details = document.createElement('span');
  details.textContent = `料號：${item.sku || '—'}｜庫存：${formatNumber(item.stock)}｜售價：${formatNumber(item.price)}`;
  result.append(name, details);
  result.hidden = false;
}

function openManageAuth() {
  $('manage-auth-error').hidden = true;
  $('manage-auth-password').value = '';
  $('manage-auth-dialog').showModal();
  $('manage-auth-password').focus();
}

function requestPage(page) {
  if (page === 'manage') return openManageAuth();
  location.hash = page;
}

document.querySelector('.page-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page-target]');
  if (button) requestPage(button.dataset.pageTarget);
});

$('manage-auth-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('manage-auth-submit');
  button.disabled = true;
  $('manage-auth-error').hidden = true;
  try {
    const { error } = await window.AppAuth.signIn(currentUser.username, $('manage-auth-password').value);
    if (error) throw error;
    const user = await window.AppAuth.requireActiveUser();
    if (user.id !== currentUser.id || user.role !== 'admin') throw new Error('帳號權限不符。');
    currentUser = user;
    manageApproved = true;
    $('manage-auth-dialog').close();
    if (location.hash === '#manage') showPage('manage');
    else location.hash = 'manage';
  } catch {
    $('manage-auth-error').textContent = '密碼不正確，或登入已失效。';
    $('manage-auth-error').hidden = false;
    $('manage-auth-password').focus();
  } finally {
    $('manage-auth-password').value = '';
    button.disabled = false;
  }
});

$('manage-auth-cancel')?.addEventListener('click', () => $('manage-auth-dialog').close());

window.addEventListener('hashchange', () => showPage(currentPage()));

function backupTimestamp() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(/[-: ]/g, '');
}

function downloadBackup(data, name = 'motorcycle-inventory-backup') {
  const url = URL.createObjectURL(new Blob([toBackup(data)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}-${backupTimestamp()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

if ($('item-list')) $('item-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const item = state.items.find((candidate) => candidate.id === button.dataset.id);
  if (!item) return;
  if (button.dataset.action !== 'print-qr' && document.body.dataset.role !== 'admin') return;
  if (button.dataset.action === 'edit') startEditing(item);
  if (button.dataset.action === 'print-qr') showQrLabel(item);
  if (button.dataset.action === 'delete' && confirm(`確定刪除「${item.name}」及其全部異動紀錄？`)) {
    try {
      if (!await saveState(deleteItem(state, item.id))) return;
      render();
      setStatus('品項與相關異動紀錄已刪除。');
    } catch (error) {
      setStatus(error.message, true);
    }
  }
});

function showQrLabel(item) {
  const label = $('qr-label');
  const content = $('qr-label-content');
  if (!window.qrcode) throw new Error('QR Code 元件尚未載入，請確認網路後重試。');
  content.replaceChildren();
  const name = document.createElement('strong');
  name.textContent = item.name;
  const sku = document.createElement('span');
  sku.textContent = item.sku ? `料號：${item.sku}` : '';
  const serial = document.createElement('span');
  serial.textContent = `原廠序號：${item.serialNumber || '未指定'}`;
  const qr = window.qrcode(0, 'M');
  qr.addData(item.serialNumber ? `${item.barcode}|${item.serialNumber}` : item.barcode);
  qr.make();
  const svg = document.createElement('div');
  svg.className = 'qr-code';
  svg.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
  const number = document.createElement('span');
  number.className = 'barcode-number';
  number.textContent = item.barcode;
  content.append(name, sku, serial, svg, number);
  label.hidden = false;
  document.body.classList.add('printing-barcode');
  window.print();
}

window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing-barcode');
  $('qr-label').hidden = true;
});

if ($('transaction-form')) $('transaction-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (currentUser?.role !== 'admin') return showFormError('transaction-form', '只有店長可以異動庫存。');
  if (pendingSave) return;
  try {
    const next = recordTransaction(state, {
      itemId: $('transaction-item').value,
      type: $('transaction-type').value,
      quantity: $('transaction-quantity').value,
      note: $('transaction-note').value,
      warrantyId: $('transaction-warranty').value,
      createdByAccount: currentUser?.displayName || currentUser?.username || currentUser?.id,
      serialNumbers: serialNumbersFromInput($('transaction-serial-numbers').value),
      serialIds: Array.from($('transaction-serial-ids').selectedOptions, option => option.value),
      createdBy: currentUser?.id,
      allowExpiredWarranty: currentUser?.role === 'admin',
    });
    if (!await saveState(next)) return;
    $('transaction-form').reset();
    $('transaction-scan-result').hidden = true;
    clearFormError('transaction-form');
    render();
    setStatus(next.transactions.at(-1).type === 'warranty_out' ? '出保固已記錄，庫存已扣除，保固到期日不變。' : '庫存異動已記錄。');
  } catch (error) {
    showFormError('transaction-form', error.message);
  }
});

$('export-button').addEventListener('click', () => {
  try {
    downloadBackup(state);
    setStatus('備份檔已匯出。');
  } catch (error) {
    setStatus(`無法匯出備份：${error.message}`, true);
  }
});

$('import-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  if (typeof window !== 'undefined' && window.AppData) {
    setStatus('雲端模式不可使用舊式覆蓋還原；資料以雲端為準，備份檔僅供保存與核對。', true);
    return;
  }
  try {
    const raw = JSON.parse(await file.text());
    const imported = validateState(raw);
    const missingPurchasing = (!imported.suppliers.length && state.suppliers.length) || (!imported.purchases.length && state.purchases.length);
    const missingSerials = raw.serials === undefined && state.serials.length > 0;
    const warning = '匯入會覆蓋目前全部資料（含序號、保固、供應商、進貨、客戶與銷售），不是合併。' + (missingPurchasing ? '此備份未包含目前的供應商或進貨資料，還原會清空相應資料。' : '') + (missingSerials ? '此舊備份沒有序號資料，還原將清空目前所有序號紀錄；機車與電池須重新核對補登。' : '') + '確定繼續嗎？';
    if (!confirm(warning)) return;
    downloadBackup(state, 'motorcycle-inventory-before-import');
    if (!await saveState(imported)) return;
    resetItemForm();
    resetSupplierForm();
    resetPurchaseForm();
    selectedPurchaseId = '';
    render();
    setStatus('備份已還原。');
  } catch (error) {
    setStatus(`無法匯入備份：${error.message}`, true);
  }
});

function serialNumbersFromInput(value) { return value.split(/\r?\n/).map(value => value.trim()).filter(Boolean); }
function keepSerialEnterInField(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const input = event.currentTarget;
  const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + '\n' + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + 1;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
// 序號管理：先看各品項的序號總覽，點「查看序號」才在彈出視窗列出該品項的序號。
// 視窗內一次顯示 20 筆（最新登錄的在前），按「顯示更多」再多 20 筆；換品項或改搜尋就回到前 20 筆。
const SERIAL_PAGE_SIZE = 20;
const SERIAL_STATUS_LABELS = { in_stock: '在庫', sold: '已售', removed: '已移出', warranty_out: '已出保固', repair_used: '維修使用' };
let serialVisibleLimit = SERIAL_PAGE_SIZE;
let serialFilterKey = '';
let serialDialogItemId = '';
function renderSerialInventory() {
  const select = $('serial-item'), selected = select.value;
  const category = $('serial-category').value;
  const items = state.items.filter(item => requiresSerial(item) && (!category || item.category === category));
  select.replaceChildren(new Option('請選擇車身或電池', ''));
  items.forEach(item => select.append(new Option(item.name, item.id)));
  select.value = items.some(item => item.id === selected) ? selected : '';
  const item = state.items.find(item => item.id === select.value);
  const count = state.serials.filter(s => s.itemId === item?.id && s.status === 'in_stock').length;
  $('serial-summary').textContent = !item ? '先選品項，再補登現有實物；補登不增加庫存。' : !Number.isSafeInteger(item.stock) ? '庫存不是安全整數，請先盤點更正。' : `庫存 ${item.stock}｜已登錄在庫 ${count}｜待補登 ${item.stock - count}`;
  const query = $('serial-search').value.trim().toLocaleLowerCase();
  const matchesQuery = (serial, text) => !text || serial.serialNumber.toLocaleLowerCase().includes(text);
  const overview = $('serial-overview'); overview.replaceChildren();
  items.forEach(product => {
    const serials = state.serials.filter(s => s.itemId === product.id);
    if (query && !serials.some(s => matchesQuery(s, query))) return;
    const count = status => serials.filter(s => s.status === status).length;
    const row = document.createElement('tr');
    [product.name, product.category, count('in_stock'), count('sold'), count('warranty_out'), count('removed') + count('repair_used')].forEach(value => { const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell); });
    const actions = document.createElement('td'), button = document.createElement('button');
    button.type = 'button'; button.className = 'secondary'; button.textContent = `查看序號（${serials.length}）`;
    button.dataset.action = 'open-serial-dialog'; button.dataset.id = product.id;
    actions.append(button); row.append(actions); overview.append(row);
  });
  if (!overview.children.length) appendEmpty(overview, query ? '沒有品項含有這個序號。' : '目前沒有車身或電池品項。');
  renderSerialDialog();
}
function renderSerialDialog() {
  const product = state.items.find(item => item.id === serialDialogItemId);
  const list = $('serial-list'); if (!list) return; list.replaceChildren();
  if (!product) return;
  $('serial-dialog-title').textContent = `${product.name} 的原廠序號`;
  const query = ($('serial-dialog-search')?.value ?? '').trim().toLocaleLowerCase();
  const filterKey = [product.id, query].join('|');
  if (filterKey !== serialFilterKey) { serialFilterKey = filterKey; serialVisibleLimit = SERIAL_PAGE_SIZE; }
  const matches = state.serials
    .filter(s => s.itemId === product.id && (!query || s.serialNumber.toLocaleLowerCase().includes(query)))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const shown = matches.slice(0, serialVisibleLimit);
  const countLabel = $('serial-list-count'), moreButton = $('serial-show-more');
  if (countLabel) countLabel.textContent = matches.length ? `顯示 ${shown.length}／共 ${matches.length} 筆` : '';
  if (moreButton) { moreButton.hidden = shown.length >= matches.length; moreButton.textContent = `顯示更多（再 ${Math.min(SERIAL_PAGE_SIZE, matches.length - shown.length)} 筆）`; }
  shown.forEach(serial => {
    const row = document.createElement('tr');
    const customer = state.customers.find(c => c.id === serial.customerId);
    [serial.serialNumber, SERIAL_STATUS_LABELS[serial.status] ?? serial.status, customer?.name || '—', serial.soldAt ? new Date(serial.soldAt).toLocaleDateString('zh-TW') : serial.status === 'warranty_out' ? new Date(serial.removedAt).toLocaleDateString('zh-TW') : '—'].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
    const actions = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'secondary'; button.textContent = '列印 QR Code';
    button.dataset.action = 'print-serial-qr'; button.dataset.id = serial.id;
    actions.append(button); row.append(actions);
    list.append(row);
  });
  if (!list.children.length) appendEmpty(list, '沒有符合條件的序號紀錄。');
}
function openSerialDialog(itemId) {
  serialDialogItemId = itemId;
  const search = $('serial-dialog-search'), main = $('serial-search');
  // 從總覽搜尋點進來時，帶入同樣的搜尋字，直接看到那個序號。
  if (search) search.value = main?.value ?? '';
  renderSerialDialog();
  const dialog = $('serial-dialog');
  if (typeof dialog?.showModal === 'function' && !dialog.open) dialog.showModal();
}
function renderTransactionSerials() {
  const item = state.items.find(item => item.id === $('transaction-item').value);
  $('transaction-serial-fields').hidden = !requiresSerial(item);
  const select = $('transaction-serial-ids'), selected = new Set(Array.from(select.selectedOptions, option => option.value));
  select.replaceChildren();
  state.serials.filter(s => s.itemId === item?.id && s.status === 'in_stock').forEach(serial => { const option = new Option(serial.serialNumber, serial.id); option.selected = selected.has(serial.id); select.append(option); });
  const type = $('transaction-type').value;
  $('transaction-serial-numbers').parentElement.hidden = type === 'out' || type === 'warranty_out';
  select.parentElement.hidden = type === 'in';
  $('transaction-serial-hint').textContent = type === 'warranty_out' ? '出保固：請選換出實物的在庫序號，數量必須相符；原故障品不會自動入庫。' : '車身／電池：入庫填新增序號；移出選在庫序號並填原因；盤點數量為目標庫存。實際銷售請用銷售管理。';
}
function renderTransactionWarranty() {
  const active = $('transaction-type').value === 'warranty_out';
  const select = $('transaction-warranty'), selected = select.value;
  $('transaction-warranty-fields').hidden = !active;
  select.required = active; select.disabled = !active;
  $('transaction-note').required = active;
  select.replaceChildren(new Option('請選擇原保固', ''));
  state.warranties.forEach(w => select.append(new Option(`${w.customerName}｜${w.itemName}｜序號：${w.serialNumber || '未登錄'}｜到期 ${w.expiresAt}`, w.id)));
  select.value = state.warranties.some(w => w.id === selected) ? selected : '';
  const warranty = state.warranties.find(w => w.id === select.value);
  const expired = warranty && warranty.expiresAt < new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  $('transaction-warranty-summary').textContent = warranty ? `客戶：${warranty.customerName}｜更換品沿用到期日：${warranty.expiresAt}${expired ? '｜原保固已到期，請店長確認是否仍免費更換。' : ''}` : state.warranties.length ? '請先選擇原保固，客戶與到期日由原紀錄帶入。' : '尚無保固紀錄，請先至保固管理建立。';
}
$('serial-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  if (currentUser?.role !== 'admin') return showFormError('serial-form', '只有店長可以補登序號。');
  if (pendingSave) return;
  try {
    const next = registerSerials(state, { itemId: $('serial-item').value, serialNumbers: serialNumbersFromInput($('serial-numbers').value), createdBy: currentUser.id });
    if (!await saveState(next)) return;
    $('serial-numbers').value = ''; clearFormError('serial-form'); render(); setStatus('序號已補登，庫存數量不變。');
  } catch (error) { showFormError('serial-form', error.message); }
});
$('serial-item')?.addEventListener('change', () => { $('serial-numbers').value = ''; renderSerialInventory(); });
$('serial-category')?.addEventListener('change', () => { $('serial-item').value = ''; $('serial-numbers').value = ''; clearFormError('serial-form'); renderSerialInventory(); });
$('serial-search')?.addEventListener('input', renderSerialInventory);
$('serial-show-more')?.addEventListener('click', () => { serialVisibleLimit += SERIAL_PAGE_SIZE; renderSerialDialog(); });
$('serial-overview')?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action="open-serial-dialog"]');
  if (button) openSerialDialog(button.dataset.id);
});
$('serial-dialog-search')?.addEventListener('input', renderSerialDialog);
$('serial-dialog-close')?.addEventListener('click', () => $('serial-dialog')?.close?.());
$('serial-dialog')?.addEventListener('close', () => { serialDialogItemId = ''; });
$('serial-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action="print-serial-qr"]');
  if (!button) return;
  const serial = state.serials.find(entry => entry.id === button.dataset.id);
  const item = state.items.find(entry => entry.id === serial?.itemId);
  if (serial && item) showQrLabel({ ...item, serialNumber: serial.serialNumber });
});
for (const id of ['item-serial-numbers', 'serial-numbers', 'transaction-serial-numbers']) $(id)?.addEventListener('keydown', keepSerialEnterInField);
$('transaction-item')?.addEventListener('change', () => { $('transaction-serial-numbers').value = ''; renderTransactionSerials(); });
$('transaction-type')?.addEventListener('change', () => { $('transaction-serial-numbers').value = ''; $('transaction-serial-ids').value = ''; renderTransactionSerials(); renderTransactionWarranty(); });
$('transaction-warranty')?.addEventListener('change', renderTransactionWarranty);

function renderPurchaseReceiptSerials(purchase) {
  const fields = $('purchase-receipt-fields'); fields.replaceChildren();
  purchase.lines.filter(line => requiresSerial(state.items.find(item => item.id === line.itemId))).forEach(line => {
    const field = document.createElement('div'); field.className = 'field';
    const label = document.createElement('label'); label.textContent = `${state.items.find(item => item.id === line.itemId).name}｜應收 ${line.quantity} 件（每行一個序號）`;
    const input = document.createElement('textarea'); input.rows = 3; input.id = `receipt-serial-${line.itemId}`; label.htmlFor = input.id;
    input.value = (receiptSerialNumbersByItem[line.itemId] || []).join('\n');
    input.addEventListener('input', () => { receiptSerialNumbersByItem[line.itemId] = serialNumbersFromInput(input.value); });
    input.addEventListener('keydown', keepSerialEnterInField);
    field.append(label, input); fields.append(field);
  });
  $('purchase-receipt-panel').hidden = false;
  $('purchase-receipt-confirm').dataset.id = receiptPurchaseId;
  $('purchase-receipt-confirm').dataset.purchaseAction = 'receive';
}

function supplierName(supplierId) {
  const supplier = state.suppliers.find((entry) => entry.id === supplierId);
  return supplier ? `${supplier.name}${supplier.active ? '' : '（已停用）'}` : '未指定';
}

function tableEmpty(list, columns, message) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = columns;
  cell.className = 'empty';
  cell.textContent = message;
  row.append(cell);
  list.append(row);
}

function renderItemSuppliers() {
  const select = $('item-supplier');
  if (!select) return;
  const selected = select.value;
  const existingId = state.items.find((item) => item.id === $('item-id').value)?.supplierId;
  select.replaceChildren(new Option('未指定供應商', ''));
  state.suppliers.filter((supplier) => supplier.active || supplier.id === existingId).forEach((supplier) => select.append(new Option(supplierName(supplier.id), supplier.id)));
  select.value = state.suppliers.some((supplier) => supplier.id === selected && (supplier.active || supplier.id === existingId)) ? selected : '';
}

function resetSupplierForm() {
  $('supplier-form').reset();
  $('supplier-id').value = '';
  $('supplier-form-title').textContent = '新增供應商';
  $('supplier-cancel').hidden = true;
  clearFormError('supplier-form');
}

function renderSuppliers() {
  const list = $('supplier-list');
  const query = $('supplier-search').value.trim().toLowerCase();
  const filter = $('supplier-status-filter').value;
  list.replaceChildren();
  state.suppliers.filter((supplier) => (!filter || (filter === 'active' ? supplier.active : !supplier.active)) && [supplier.name, supplier.contact, supplier.phone, supplier.taxId].some((value) => value.toLowerCase().includes(query))).forEach((supplier) => {
    const row = document.createElement('tr');
    [supplier.name, supplier.contact || '—', supplier.phone || '—', supplier.address || '—', supplier.taxId || '—', supplier.note || '—', supplier.active ? '啟用' : '已停用'].forEach((value) => {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    });
    const actions = document.createElement('td');
    actions.className = 'actions';
    if (document.body.dataset.role === 'admin') {
      for (const [label, action] of [['編輯', 'edit'], ...(supplier.active ? [['停用', 'deactivate']] : [])]) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'secondary'; button.textContent = label;
        button.dataset.supplierAction = action; button.dataset.id = supplier.id; actions.append(button);
      }
    }
    row.append(actions); list.append(row);
  });
  if (!list.children.length) tableEmpty(list, 8, '沒有符合條件的供應商。');
}

let supplierBusy = false;
$('supplier-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (supplierBusy || document.body.dataset.role !== 'admin') return;
  supplierBusy = true;
  try {
    const fields = {};
    for (const key of ['name', 'contact', 'phone', 'address', 'taxId', 'note']) fields[key] = $(`supplier-${key === 'taxId' ? 'tax-id' : key}`).value;
    const supplierId = $('supplier-id').value;
    const next = supplierId ? updateSupplier(state, supplierId, fields) : addSupplier(state, fields);
    if (!await saveState(next)) return;
    resetSupplierForm(); render(); setStatus('供應商已儲存。');
  } catch (error) { showFormError('supplier-form', error.message); }
  finally { supplierBusy = false; }
});
$('supplier-list')?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-supplier-action]');
  if (!button || supplierBusy || document.body.dataset.role !== 'admin') return;
  const supplier = state.suppliers.find((entry) => entry.id === button.dataset.id);
  if (!supplier) return;
  if (button.dataset.supplierAction === 'edit') {
    $('supplier-id').value = supplier.id;
    for (const key of ['name', 'contact', 'phone', 'address', 'taxId', 'note']) $(`supplier-${key === 'taxId' ? 'tax-id' : key}`).value = supplier[key];
    $('supplier-form-title').textContent = `編輯：${supplier.name}`;
    $('supplier-cancel').hidden = false; clearFormError('supplier-form'); $('supplier-name').focus();
  } else if (button.dataset.supplierAction === 'deactivate' && confirm(`確定停用「${supplier.name}」？既有進貨紀錄仍會保留。`)) {
    supplierBusy = true;
    try {
      if (!await saveState(deactivateSupplier(state, supplier.id))) return;
      render(); setStatus('供應商已停用，既有草稿仍可收貨。');
    } catch (error) { setStatus(error.message, true); }
    finally { supplierBusy = false; }
  }
});
$('supplier-cancel')?.addEventListener('click', resetSupplierForm);
$('supplier-search')?.addEventListener('input', renderSuppliers);
$('supplier-status-filter')?.addEventListener('change', renderSuppliers);

let purchaseLines = [];
let purchaseSupplierId = '';
let selectedPurchaseId = '';
let purchaseBusy = false;

function purchaseHasUnsavedContent() {
  return purchaseLines.length > 0 || Boolean($('purchase-note').value.trim()) || Boolean($('purchase-item').value) || Boolean($('purchase-unit-cost').value) || !['', '1'].includes($('purchase-quantity').value);
}

function resetPurchaseForm() {
  $('purchase-form').reset();
  $('purchase-id').value = '';
  $('purchase-supplier').value = '';
  $('purchase-quantity').value = '1';
  $('purchase-unit-cost').value = '';
  purchaseLines = [];
  purchaseSupplierId = '';
  $('purchase-form-title').textContent = '新增進貨草稿';
  $('purchase-cancel').hidden = false;
  clearFormError('purchase-form');
  renderPurchaseBuilder();
}

function renderPurchaseBuilder() {
  const supplierSelect = $('purchase-supplier');
  const supplierId = supplierSelect.value;
  const existing = state.purchases.find((entry) => entry.id === $('purchase-id').value);
  supplierSelect.replaceChildren(new Option('請選供應商', ''));
  state.suppliers.filter((entry) => entry.active || entry.id === existing?.supplierId).forEach((entry) => supplierSelect.append(new Option(supplierName(entry.id), entry.id)));
  supplierSelect.value = state.suppliers.some((entry) => entry.id === supplierId && (entry.active || entry.id === existing?.supplierId)) ? supplierId : '';
  const itemSelect = $('purchase-item');
  const itemId = itemSelect.value;
  itemSelect.replaceChildren(new Option('請選此供應商的品項', ''));
  state.items.filter((entry) => entry.supplierId && entry.supplierId === supplierSelect.value).forEach((entry) => itemSelect.append(new Option(`${entry.name}（${entry.sku || '無料號'}）`, entry.id)));
  itemSelect.value = state.items.some((entry) => entry.id === itemId && entry.supplierId === supplierSelect.value) ? itemId : '';
  renderPurchaseLines();
}

function renderPurchaseLines() {
  const list = $('purchase-lines');
  list.replaceChildren();
  let cents = 0;
  let valid = true;
  purchaseLines.forEach((line, index) => {
    const row = document.createElement('tr');
    const item = state.items.find((entry) => entry.id === line.itemId);
    for (const value of [item?.name ?? line.itemName ?? '品項不存在', item?.sku ?? line.sku ?? '—']) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    for (const [field, label, step, min] of [['quantity', '數量', '1', '1'], ['unitCost', '進貨單價', '0.01', '0']]) {
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number'; input.step = step; input.min = min; input.required = true; input.value = String(line[field]);
      input.setAttribute('aria-label', `${item?.name ?? line.itemName} ${label}`);
      input.dataset.purchaseLine = String(index); input.dataset.field = field;
      cell.append(input); row.append(cell);
    }
    const subtotal = Math.round(Number(line.unitCost) * 100) * Number(line.quantity);
    const lineValid = Number.isSafeInteger(subtotal) && subtotal >= 0 && Number.isSafeInteger(Number(line.quantity)) && Number(line.quantity) > 0 && /^\d+(\.\d{1,2})?$/.test(String(line.unitCost));
    valid = valid && lineValid;
    cents += subtotal;
    const cell = document.createElement('td'); cell.textContent = lineValid ? `NT$ ${formatNumber(subtotal / 100)}` : '請修正'; row.append(cell);
    const actions = document.createElement('td');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = '移除'; button.dataset.purchaseRemove = String(index);
    actions.append(button); row.append(actions); list.append(row);
  });
  if (!list.children.length) tableEmpty(list, 6, '先選供應商，再加入進貨品項。');
  $('purchase-total').textContent = valid && Number.isSafeInteger(cents) ? formatNumber(cents / 100) : '請修正明細';
}

function renderPurchases() {
  const list = $('purchase-list');
  list.replaceChildren();
  const query = $('purchase-search').value.trim().toLowerCase();
  const status = $('purchase-status-filter').value;
  const payment = $('purchase-payment-filter').value;
  [...state.purchases].reverse().filter((purchase) => (!status || purchase.status === status) && (!payment || purchase.paymentStatus === payment) && [purchase.number, purchase.supplierSnapshot.name].some((value) => value.toLowerCase().includes(query))).forEach((purchase) => {
    const row = document.createElement('tr');
    [purchase.number, purchase.supplierSnapshot.name, `NT$ ${formatNumber(purchase.total)}`, purchase.status === 'draft' ? '草稿' : '已收貨', purchase.paymentStatus === 'paid' ? '已付款' : '未付款'].forEach((value) => {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    });
    const actions = document.createElement('td'); actions.className = 'actions';
    if (document.body.dataset.role === 'admin') {
      const choices = [['查看', 'view'], ...(purchase.status === 'draft' ? [['編輯', 'edit'], ['確認收貨', 'receive'], ['刪除草稿', 'delete']] : purchase.paymentStatus === 'unpaid' ? [['標記已付款', 'paid']] : [])];
      choices.forEach(([label, action]) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = action === 'delete' ? 'danger' : 'secondary'; button.textContent = label;
        button.dataset.purchaseAction = action; button.dataset.id = purchase.id; actions.append(button);
      });
    }
    row.append(actions); list.append(row);
  });
  if (!list.children.length) tableEmpty(list, 6, '沒有符合條件的進貨單。');
}

function purchaseOperator(userId, account) {
  return account || (userId === currentUser?.id ? currentUser.displayName || currentUser.username || userId : userId) || '—';
}

function renderPurchaseDetail() {
  const detail = $('purchase-detail');
  detail.replaceChildren();
  const purchase = state.purchases.find((entry) => entry.id === selectedPurchaseId);
  detail.hidden = !purchase;
  if (!purchase) return;
  const heading = document.createElement('h3'); heading.textContent = `進貨單 ${purchase.number}`; detail.append(heading);
  const supplier = purchase.supplierSnapshot;
  const status = purchase.status === 'draft' ? '草稿' : '已收貨（明細唯讀）';
  for (const value of [`供應商：${supplier.name}｜聯絡人：${supplier.contact || '—'}｜電話：${supplier.phone || '—'}`, `地址：${supplier.address || '—'}｜統編：${supplier.taxId || '—'}`, `狀態：${status}｜付款：${purchase.paymentStatus === 'paid' ? '已付款' : '未付款'}`, `建立：${new Date(purchase.createdAt).toLocaleString('zh-TW')}｜操作者：${purchaseOperator(purchase.createdBy, purchase.createdByAccount)}`, `收貨：${purchase.receivedAt ? new Date(purchase.receivedAt).toLocaleString('zh-TW') : '—'}｜操作者：${purchaseOperator(purchase.receivedBy, purchase.receivedByAccount)}`, `付款：${purchase.paidAt ? new Date(purchase.paidAt).toLocaleString('zh-TW') : '—'}｜操作者：${purchaseOperator(purchase.paidBy, purchase.paidByAccount)}`, `備註：${purchase.note || '—'}`]) {
    const paragraph = document.createElement('p'); paragraph.textContent = value; detail.append(paragraph);
  }
  const wrapper = document.createElement('div'); wrapper.className = 'table-wrap';
  const table = document.createElement('table'); table.className = 'purchase-detail-table'; const header = document.createElement('tr');
  ['品項', '料號', '條碼', '數量', '進貨單價', '小計'].forEach((value) => { const cell = document.createElement('th'); cell.textContent = value; header.append(cell); });
  const head = document.createElement('thead'); head.append(header); table.append(head);
  const body = document.createElement('tbody');
  purchase.lines.forEach((line) => {
    const row = document.createElement('tr');
    [line.itemName, line.sku || '—', line.barcode || '—', formatNumber(line.quantity), `NT$ ${formatNumber(line.unitCost)}`, `NT$ ${formatNumber(line.subtotal)}`].forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
    body.append(row);
  });
  table.append(body); wrapper.append(table); detail.append(wrapper);
  const total = document.createElement('p'); total.textContent = `進貨總額：NT$ ${formatNumber(purchase.total)}`; detail.append(total);
}

$('purchase-supplier')?.addEventListener('change', () => {
  if (purchaseBusy) { $('purchase-supplier').value = purchaseSupplierId; return; }
  const nextId = $('purchase-supplier').value;
  if (nextId !== purchaseSupplierId && purchaseHasUnsavedContent() && !confirm('更換供應商會清空目前進貨明細與待加入品項（備註保留），確定繼續嗎？')) {
    $('purchase-supplier').value = purchaseSupplierId; return;
  }
  if (nextId !== purchaseSupplierId) purchaseLines = [];
  purchaseSupplierId = nextId;
  $('purchase-item').value = ''; $('purchase-unit-cost').value = '';
  clearFormError('purchase-form'); renderPurchaseBuilder();
});
$('purchase-item')?.addEventListener('change', () => {
  const item = state.items.find((entry) => entry.id === $('purchase-item').value);
  const [mantissa, exponent = '0'] = String(item?.cost ?? 0).split('e');
  const rounded = Math.round(Number(`${mantissa}e${Number(exponent) + 2}`)) / 100;
  $('purchase-unit-cost').value = item ? rounded.toFixed(2) : '';
});
$('purchase-add-line')?.addEventListener('click', () => {
  if (purchaseBusy || document.body.dataset.role !== 'admin') return;
  const itemId = $('purchase-item').value;
  const item = state.items.find((entry) => entry.id === itemId && entry.supplierId === $('purchase-supplier').value);
  if (!item) return showFormError('purchase-form', '請選擇此供應商的品項；未指定品項請先到庫存管理設定供應商。');
  if (purchaseLines.some((entry) => entry.itemId === itemId)) return showFormError('purchase-form', '此品項已有明細，請直接修改數量，勿重複加入。');
  const quantity = Number($('purchase-quantity').value);
  const unitCost = $('purchase-unit-cost').value;
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || !/^\d+(\.\d{1,2})?$/.test(unitCost) || !Number.isSafeInteger(Math.round(Number(unitCost) * 100) * quantity)) return showFormError('purchase-form', '數量須為正整數，單價須為非負數且最多兩位小數，金額不可超出安全範圍。');
  purchaseLines.push({ itemId, quantity, unitCost });
  clearFormError('purchase-form'); renderPurchaseLines();
});
$('purchase-lines')?.addEventListener('change', (event) => {
  if (purchaseBusy || document.body.dataset.role !== 'admin') return;
  const { purchaseLine, field } = event.target.dataset;
  if (!['quantity', 'unitCost'].includes(field) || !purchaseLines[Number(purchaseLine)]) return;
  purchaseLines[Number(purchaseLine)][field] = event.target.value;
  renderPurchaseLines();
});
$('purchase-lines')?.addEventListener('click', (event) => {
  if (purchaseBusy || document.body.dataset.role !== 'admin') return;
  const button = event.target.closest('button[data-purchase-remove]');
  if (!button) return;
  purchaseLines.splice(Number(button.dataset.purchaseRemove), 1); renderPurchaseLines();
});
$('purchase-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (purchaseBusy || supplierBusy || document.body.dataset.role !== 'admin') return;
  purchaseBusy = true;
  try {
    const fields = { supplierId: $('purchase-supplier').value, lines: purchaseLines, note: $('purchase-note').value, createdBy: currentUser?.id, createdByAccount: currentUser?.displayName || currentUser?.username || currentUser?.id };
    const purchaseId = $('purchase-id').value;
    const next = purchaseId ? updatePurchase(state, purchaseId, fields) : createPurchase(state, fields);
    if (!await saveState(next)) return;
    resetPurchaseForm(); render(); setStatus('進貨草稿已儲存，尚未增加庫存。');
  } catch (error) { showFormError('purchase-form', error.message); }
  finally { purchaseBusy = false; }
});
async function handlePurchaseAction(event) {
  const button = event.target.closest('button[data-purchase-action]');
  if (!button || purchaseBusy || supplierBusy || document.body.dataset.role !== 'admin') return;
  const purchase = state.purchases.find((entry) => entry.id === button.dataset.id);
  if (!purchase) return;
  const action = button.dataset.purchaseAction;
  if (action === 'receive' && purchase.status === 'draft' && purchase.lines.some(line => requiresSerial(state.items.find(item => item.id === line.itemId))) && (receiptPurchaseId !== purchase.id || button.id !== 'purchase-receipt-confirm')) {
    if (receiptPurchaseId !== purchase.id && Object.values(receiptSerialNumbersByItem).some(numbers => numbers.length) && !confirm('切換收貨單會清除未儲存的序號，確定繼續？')) return;
    if (receiptPurchaseId !== purchase.id) { receiptPurchaseId = purchase.id; receiptSerialNumbersByItem = {}; }
    renderPurchaseReceiptSerials(purchase); $('purchase-receipt-panel').scrollIntoView({ block: 'nearest' }); return;
  }
  if (action === 'view') { selectedPurchaseId = purchase.id; renderPurchaseDetail(); return; }
  if (action === 'edit') {
    if (purchase.status !== 'draft') return;
    if (purchaseHasUnsavedContent() && !confirm('載入這張草稿會取代目前所有未儲存內容（含備註），確定繼續嗎？')) return;
    $('purchase-id').value = purchase.id;
    purchaseSupplierId = purchase.supplierId;
    purchaseLines = purchase.lines.map((line) => ({ ...line }));
    renderPurchaseBuilder(); $('purchase-supplier').value = purchase.supplierId; renderPurchaseBuilder();
    $('purchase-note').value = purchase.note; $('purchase-cancel').hidden = false;
    $('purchase-form-title').textContent = `編輯草稿：${purchase.number}`;
    clearFormError('purchase-form'); $('purchase-supplier').focus(); return;
  }
  const prompts = {
    receive: `確認整張收貨？\n${purchase.number}｜${purchase.supplierSnapshot.name}\n總數 ${formatNumber(purchase.lines.reduce((sum, line) => sum + line.quantity, 0))}｜總額 NT$ ${formatNumber(purchase.total)}\n將增加庫存並更新成本，收貨後不可修改或刪除。`,
    delete: `確定刪除草稿 ${purchase.number}？不會影響庫存。`,
    paid: `確認 ${purchase.number} 已付款 NT$ ${formatNumber(purchase.total)}？此標記不執行轉帳，且第一版不能撤銷。`,
  };
  if (!prompts[action]) return;
  if ($('purchase-id').value === purchase.id && action === 'receive' && !confirm('目前正在編輯此草稿；收貨將使用最後儲存版本，未儲存的修改不會套用，確定繼續嗎？')) return;
  if (!confirm(prompts[action])) return;
  purchaseBusy = true;
  try {
    const account = currentUser?.displayName || currentUser?.username || currentUser?.id;
    const next = action === 'receive' ? receivePurchase(state, purchase.id, { receivedBy: currentUser?.id, receivedByAccount: account, serialNumbersByItem: receiptPurchaseId === purchase.id ? receiptSerialNumbersByItem : {} }) : action === 'paid' ? markPurchasePaid(state, purchase.id, { paidBy: currentUser?.id, paidByAccount: account }) : deletePurchase(state, purchase.id);
    if (!await saveState(next)) return;
    if (receiptPurchaseId === purchase.id && ['receive', 'delete'].includes(action)) { receiptPurchaseId = ''; receiptSerialNumbersByItem = {}; $('purchase-receipt-panel').hidden = true; }
    if ($('purchase-id').value === purchase.id) resetPurchaseForm();
    selectedPurchaseId = action === 'delete' ? '' : purchase.id;
    render(); renderPurchaseDetail();
    setStatus(action === 'receive' ? '進貨已收貨，庫存與成本已更新。' : action === 'paid' ? '進貨單已標記付款。' : '進貨草稿已刪除。');
  } catch (error) { showFormError('purchase-form', error.message); }
  finally { purchaseBusy = false; }
}
$('purchase-list')?.addEventListener('click', handlePurchaseAction);
$('purchase-receipt-confirm')?.addEventListener('click', handlePurchaseAction);
$('purchase-receipt-cancel')?.addEventListener('click', () => {
  if (purchaseBusy || (Object.values(receiptSerialNumbersByItem).some(numbers => numbers.length) && !confirm('確定清除未儲存的收貨序號？'))) return;
  receiptPurchaseId = ''; receiptSerialNumbersByItem = {}; $('purchase-receipt-panel').hidden = true;
});
$('purchase-cancel')?.addEventListener('click', () => {
  if (!purchaseBusy && (!purchaseHasUnsavedContent() || confirm('確定清除目前所有未儲存的進貨內容（含備註）？'))) resetPurchaseForm();
});
$('purchase-search')?.addEventListener('input', renderPurchases);
$('purchase-status-filter')?.addEventListener('change', renderPurchases);
$('purchase-payment-filter')?.addEventListener('change', renderPurchases);

function renderCustomers() {
  const query = $('customer-search').value.trim().toLowerCase();
  const list = $('customer-list');
  list.replaceChildren();
  state.customers.filter((customer) => [customer.memberNumber, customer.name, customer.phone, customer.plateNumbers.join(' '), customer.address].some((value) => value.toLowerCase().includes(query))).forEach((customer) => {
    const row = document.createElement('tr');
    [customer.memberNumber, customer.name, customer.phone, customer.plateNumbers.join('、') || '—', customer.address || '—', customer.note || '—', customer.active ? '啟用' : '已停用'].forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
    const actions = document.createElement('td'); actions.className = 'actions';
    const hasQuotation = state.quotations.some((quotation) => quotation.customerId === customer.id);
    for (const [label, action] of customer.active ? [['編輯', 'edit'], ['停用', 'deactivate'], ...(hasQuotation ? [] : [['刪除', 'delete']])] : [['編輯', 'edit']]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = action === 'deactivate' || action === 'delete' ? 'danger' : 'secondary'; button.dataset.customerAction = action; button.dataset.id = customer.id; actions.append(button); }
    row.append(actions); list.append(row);
  });
  if (!list.children.length) appendEmpty(list, '尚未建立符合條件的客戶。');
}

function resetCustomerForm() { $('customer-form').reset(); $('customer-id').value = ''; $('customer-member-number').value = ''; $('customer-form-title').textContent = '新增客戶'; $('customer-cancel').hidden = true; }
function customerFields() { return { name: $('customer-name').value, phone: $('customer-phone').value, plateNumbers: $('customer-plates').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean), address: $('customer-address').value, note: $('customer-note').value }; }

if ($('customer-form')) $('customer-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const customerId = $('customer-id').value; const next = customerId ? updateCustomer(state, customerId, customerFields()) : addCustomer(state, customerFields()); if (!await saveState(next)) return; resetCustomerForm(); clearFormError('customer-form'); render(); setStatus(customerId ? '客戶已更新。' : '客戶已新增。'); } catch (error) { showFormError('customer-form', error.message); } });
$('customer-cancel')?.addEventListener('click', resetCustomerForm);
$('customer-search')?.addEventListener('input', renderCustomers);
$('customer-list')?.addEventListener('click', async (event) => { const button = event.target.closest('button[data-customer-action]'); if (!button) return; const customer = state.customers.find((candidate) => candidate.id === button.dataset.id); if (!customer) return; if (button.dataset.customerAction === 'edit') { $('customer-id').value = customer.id; $('customer-member-number').value = customer.memberNumber; $('customer-name').value = customer.name; $('customer-phone').value = customer.phone; $('customer-plates').value = customer.plateNumbers.join('\n'); $('customer-address').value = customer.address; $('customer-note').value = customer.note; $('customer-form-title').textContent = `編輯：${customer.name}`; $('customer-cancel').hidden = false; $('customer-name').focus(); } else if (button.dataset.customerAction === 'delete' && confirm(`確定刪除「${customer.name}」？`)) { try { if (!await saveState(deleteCustomer(state, customer.id))) return; render(); setStatus('會員已刪除。'); } catch (error) { setStatus(error.message, true); } } else if (button.dataset.customerAction === 'deactivate' && confirm(`確定停用「${customer.name}」？`)) { if (!await saveState(deactivateCustomer(state, customer.id))) return; render(); setStatus('客戶已停用。'); } });

// 店員身分顯示文字（舊資料沒有身分欄位時視為業務員）。
function staffRoleLabel(person) { return [person.isSales !== false ? '業務員' : '', person.isTechnician ? '維修員' : ''].filter(Boolean).join('、'); }
function renderSalespeople() { const query = $('salesperson-search').value.trim().toLowerCase(); const list = $('salesperson-list'); list.replaceChildren(); state.salespeople.filter((salesperson) => salesperson.name.toLowerCase().includes(query)).forEach((salesperson) => { const row = document.createElement('tr'); [salesperson.name, staffRoleLabel(salesperson), salesperson.active ? '啟用' : '已停用'].forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }); const actions = document.createElement('td'); actions.className = 'actions'; for (const [label, action] of salesperson.active ? [['編輯', 'edit'], ['停用', 'deactivate']] : [['編輯', 'edit']]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = action === 'deactivate' ? 'danger' : 'secondary'; button.dataset.salespersonAction = action; button.dataset.id = salesperson.id; actions.append(button); } row.append(actions); list.append(row); }); if (!list.children.length) appendEmpty(list, '尚未建立符合條件的店員。'); }
function resetSalespersonForm() { $('salesperson-form').reset(); $('salesperson-id').value = ''; $('salesperson-form-title').textContent = '新增店員'; $('salesperson-cancel').hidden = true; }
if ($('salesperson-form')) $('salesperson-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const salespersonId = $('salesperson-id').value; const fields = { name: $('salesperson-name').value, isSales: $('salesperson-is-sales').checked, isTechnician: $('salesperson-is-technician').checked }; const next = salespersonId ? updateSalesperson(state, salespersonId, fields) : addSalesperson(state, fields); if (!await saveState(next)) return; resetSalespersonForm(); clearFormError('salesperson-form'); render(); setStatus(salespersonId ? '店員已更新。' : '店員已新增。'); } catch (error) { showFormError('salesperson-form', error.message); } });
$('salesperson-cancel')?.addEventListener('click', resetSalespersonForm);
$('salesperson-search')?.addEventListener('input', renderSalespeople);
$('salesperson-list')?.addEventListener('click', async (event) => { const button = event.target.closest('button[data-salesperson-action]'); if (!button) return; const salesperson = state.salespeople.find((candidate) => candidate.id === button.dataset.id); if (!salesperson) return; if (button.dataset.salespersonAction === 'edit') { $('salesperson-id').value = salesperson.id; $('salesperson-name').value = salesperson.name; $('salesperson-is-sales').checked = salesperson.isSales !== false; $('salesperson-is-technician').checked = salesperson.isTechnician === true; $('salesperson-form-title').textContent = `編輯：${salesperson.name}`; $('salesperson-cancel').hidden = false; $('salesperson-name').focus(); } else if (confirm(`確定停用「${salesperson.name}」？`)) { if (!await saveState(deactivateSalesperson(state, salesperson.id))) return; render(); setStatus('店員已停用。'); } });

function renderQuotationBuilder() {
  const customer = $('quotation-customer'); const salesperson = $('quotation-salesperson'); const item = $('quotation-item'); const selectedCustomer = customer.value; const selectedSalesperson = salesperson.value; const selectedItem = item.value;
  customer.replaceChildren(); salesperson.replaceChildren(); item.replaceChildren();
  state.customers.filter((candidate) => candidate.active).forEach((candidate) => customer.append(new Option(`${candidate.name}（${candidate.phone}）`, candidate.id)));
  state.salespeople.filter(person => person.active && person.isSales !== false).forEach((candidate) => salesperson.append(new Option(candidate.name, candidate.id)));
  state.items.forEach((candidate) => item.append(new Option(`${candidate.name}（庫存 ${formatNumber(candidate.stock)}）`, candidate.id)));
  if (state.customers.some((candidate) => candidate.active && candidate.id === selectedCustomer)) customer.value = selectedCustomer;
  if (state.salespeople.some((candidate) => (candidate.active && candidate.isSales !== false) && candidate.id === selectedSalesperson)) salesperson.value = selectedSalesperson;
  if (state.items.some((candidate) => candidate.id === selectedItem)) item.value = selectedItem;
  $('quotation-hourly-rate').textContent = formatNumber(hourlyRate);
  // 特惠組合：先調整套用的組數，再把各品項分到的折扣依明細順序往下扣（和存檔時的算法相同），只用來顯示。
  const promotions = globalThis.PromotionUI?.quotation;
  promotions?.sync();
  const { discount, byItem } = promotions?.summary() ?? { discount: 0, byItem: new Map() };
  const left = new Map(byItem);
  const lineDiscounts = quotationLines.map(line => { const cut = Math.min(left.get(line.itemId) ?? 0, Math.round(line.unitPrice * 100) * line.quantity); if (cut) left.set(line.itemId, left.get(line.itemId) - cut); return cut / 100; });
  const lines = $('quotation-lines'); lines.replaceChildren(); quotationLines.forEach((line, index) => { const row = document.createElement('tr'); [line.itemName, formatNumber(line.stock), `NT$ ${formatNumber(line.unitPrice)}`, formatNumber(line.quantity), line.installationRequired ? '需安裝' : '免安裝', line.installationRequired ? formatNumber(line.laborHours) : '—', line.installationRequired ? `NT$ ${formatNumber(line.hourlyRate)}` : '—', `NT$ ${formatNumber(line.subtotal)}`, `NT$ ${formatNumber(line.laborAmount)}`].forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }); if (lineDiscounts[index]) { const note = document.createElement('small'); note.className = 'sale-line-discount'; note.textContent = `組合折 −NT$ ${formatNumber(lineDiscounts[index])}`; row.children[7].append(note); } const cell = document.createElement('td'); const button = document.createElement('button'); button.type = 'button'; button.className = 'danger'; button.dataset.removeLine = String(index); button.textContent = '移除'; cell.append(button); row.append(cell); lines.append(row); });
  if (!quotationLines.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 10; cell.className = 'empty'; cell.textContent = '尚未加入明細。請選品項後按「加入明細」。'; row.append(cell); lines.append(row); }
  if ($('quotation-discount-row')) { $('quotation-discount-row').hidden = !discount; $('quotation-discount').textContent = `−NT$ ${formatNumber(discount)}`; }
  $('quotation-total').textContent = 'NT$ ' + formatNumber(Math.round((quotationLines.reduce((sum, line) => sum + line.subtotal + line.laborAmount, 0) - discount) * 100) / 100);
}
// 報價加入一列（由特惠組合一次加入時使用）：免安裝；需要安裝的可以之後再加一列。
function addQuotationItem(item, quantity) {
  if (!item || !Number.isInteger(quantity) || quantity <= 0) return false;
  quotationLines.push({ itemId: item.id, itemName: item.name, stock: item.stock, unitPrice: item.price, quantity, subtotal: item.price * quantity, installationRequired: false, laborHours: 0, hourlyRate: 0, laborAmount: 0 });
  clearFormError('quotation-form'); renderQuotationBuilder(); return true;
}
function renderQuotations() {
  const query = $('quotation-search').value.trim().toLowerCase(); const list = $('quotation-list'); list.replaceChildren();
  state.quotations.filter((quotation) => [quotation.number, quotation.customerName, quotation.customerPhone, quotation.salespersonName].some((value) => value.toLowerCase().includes(query))).forEach((quotation) => { const row = document.createElement('tr'); [quotation.number, new Date(quotation.createdAt).toLocaleDateString('zh-TW'), quotation.customerName, quotation.salespersonName || '未填寫', `NT$ ${formatNumber(quotation.total)}`].forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }); const action = document.createElement('td'); const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.dataset.quotationId = quotation.id; button.textContent = '查看／列印'; action.append(button); row.append(action); list.append(row); });
  if (!list.children.length) appendEmpty(list, '尚未有符合條件的報價。');
}
function showQuotation(quotation) { const detail = $('quotation-detail'); detail.hidden = false; const content = $('quotation-print-content'); content.replaceChildren(); const heading = document.createElement('h2'); heading.textContent = `報價單 ${quotation.number}`; const info = document.createElement('p'); info.textContent = `日期：${new Date(quotation.createdAt).toLocaleDateString('zh-TW')}｜客戶：${quotation.customerName}｜電話：${quotation.customerPhone}｜業務：${quotation.salespersonName || '未填寫'}`; const table = document.createElement('table'); const hasDiscount = quotation.lines.some(line => line.discount > 0); table.innerHTML = `<thead><tr><th>品項</th><th>單價</th><th>數量</th><th>材料小計</th>${hasDiscount ? '<th>組合折扣</th>' : ''}<th>安裝</th><th>工時</th><th>時薪</th><th>工資</th></tr></thead>`; const body = document.createElement('tbody'); quotation.lines.forEach((line) => { const row = document.createElement('tr'); [line.itemName, formatNumber(line.unitPrice), formatNumber(line.quantity), formatNumber(line.subtotal), ...(hasDiscount ? [line.discount ? `−${formatNumber(line.discount)}` : '—'] : []), line.installationRequired ? '需安裝' : '免安裝', line.installationRequired ? formatNumber(line.laborHours) : '—', line.installationRequired ? formatNumber(line.hourlyRate) : '—', formatNumber(line.laborAmount ?? 0)].forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }); body.append(row); }); table.append(body); const total = document.createElement('p'); total.textContent = `合計：${formatNumber(quotation.total)}`; const promotions = document.createElement('p'); promotions.hidden = !quotation.promotions?.length; promotions.textContent = `特惠組合：${(quotation.promotions ?? []).map(entry => `${entry.name} ×${entry.times}（−${formatNumber(entry.discount)}）`).join('、')}`; content.append(heading, info, table, promotions, total); }

$('quotation-installation-required')?.addEventListener('change', () => { const installed = $('quotation-installation-required').value === 'yes'; $('quotation-labor-hours-wrap').hidden = !installed; $('quotation-labor-hours').required = installed; if (!installed) $('quotation-labor-hours').value = ''; });
$('quotation-add-line')?.addEventListener('click', () => { const item = state.items.find((candidate) => candidate.id === $('quotation-item').value); const quantity = Number($('quotation-quantity').value); if (!item || !Number.isInteger(quantity) || quantity <= 0) return showFormError('quotation-form', '請選擇品項並輸入大於零的整數數量。'); const installationRequired = $('quotation-installation-required').value === 'yes'; const hoursText = $('quotation-labor-hours').value.trim(); if (installationRequired && (!/^\d+(\.\d{1,2})?$/.test(hoursText) || Number(hoursText) <= 0 || hourlyRate <= 0)) return showFormError('quotation-form', '需安裝時請輸入大於零的工時，並請店長設定工時費率。'); const laborHours = installationRequired ? Number(hoursText) : 0; const laborAmount = installationRequired ? Math.round(Math.round(laborHours * 100) * Math.round(hourlyRate * 100) / 100) / 100 : 0; quotationLines.push({ itemId: item.id, itemName: item.name, stock: item.stock, unitPrice: item.price, quantity, subtotal: item.price * quantity, installationRequired, laborHours, hourlyRate: installationRequired ? hourlyRate : 0, laborAmount }); clearFormError('quotation-form'); renderQuotationBuilder(); });
$('quotation-lines')?.addEventListener('click', (event) => { const button = event.target.closest('button[data-remove-line]'); if (!button) return; quotationLines.splice(Number(button.dataset.removeLine), 1); renderQuotationBuilder(); });
if ($('quotation-form')) $('quotation-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const next = createQuotation(state, { customerId: $('quotation-customer').value, salespersonId: $('quotation-salesperson').value, lines: quotationLines, hourlyRate, note: $('quotation-note').value, promotions: window.PromotionUI?.quotation?.selected() ?? [] }); if (!await saveState(next)) return; quotationLines = []; window.PromotionUI?.quotation?.reset(); $('quotation-form').reset(); $('quotation-labor-hours-wrap').hidden = true; $('quotation-labor-hours').required = false; clearFormError('quotation-form'); render(); setStatus('報價單已建立。'); } catch (error) { showFormError('quotation-form', error.message); } });
$('shop-rate-form')?.addEventListener('submit', async (event) => { event.preventDefault(); if (document.body.dataset.role !== 'admin') return showFormError('shop-rate-form', '只有店長可維護工時費率。'); try { hourlyRate = await window.AppData.setHourlyRate($('shop-hourly-rate').value); quotationLines = quotationLines.map(line => ({ ...line, hourlyRate: line.installationRequired ? hourlyRate : 0, laborAmount: line.installationRequired ? Math.round(Math.round(line.laborHours * 100) * Math.round(hourlyRate * 100) / 100) / 100 : 0 })); clearFormError('shop-rate-form'); renderQuotationBuilder(); setStatus('工時費率已更新；舊報價不變。'); } catch (error) { showFormError('shop-rate-form', error.message); } });
$('quotation-search')?.addEventListener('input', renderQuotations);
$('quotation-list')?.addEventListener('click', (event) => { const button = event.target.closest('button[data-quotation-id]'); const quotation = state.quotations.find((candidate) => candidate.id === button?.dataset.quotationId); if (quotation) showQuotation(quotation); });
$('print-quotation')?.addEventListener('click', () => window.print());

function renderSaleCustomers() {
  const select = $('sale-customer');
  const selected = select.value;
  select.replaceChildren(new Option('不指定客戶', ''));
  state.customers.filter((customer) => customer.active).forEach((customer) => select.append(new Option(`${customer.name}（${customer.phone}）`, customer.id)));
  select.value = state.customers.some((customer) => customer.active && customer.id === selected) ? selected : '';
}

// 結帳業務員選單：只列出勾選「業務員」身分的在職店員（報價、月銷售補登業務員也一樣）。
function renderSaleSalespeople() {
  const select = $('sale-salesperson');
  const selected = select.value;
  select.replaceChildren(new Option('請選擇業務員', ''));
  state.salespeople.filter(person => person.active && person.isSales !== false).forEach(person => select.append(new Option(person.name, person.id)));
  select.value = state.salespeople.some(person => (person.active && person.isSales !== false) && person.id === selected) ? selected : '';
}

function renderWarrantySelectors() {
  for (const [id, choices, placeholder] of [
    ['warranty-customer', state.customers, '請選擇客戶'],
    ['warranty-item', state.items, '請選擇品項'],
  ]) {
    const select = $(id);
    const selected = select.value;
    select.replaceChildren(new Option(placeholder, ''));
    choices.forEach((choice) => select.append(new Option(choice.name, choice.id)));
    select.value = choices.some((choice) => choice.id === selected) ? selected : '';
  }
  renderWarrantySerials();
}

function renderWarrantySerials() {
  const select = $('warranty-serial'), selected = select.value, editing = Boolean($('warranty-id').value);
  select.replaceChildren(new Option('請選擇已售序號（車身／電池必選）', ''));
  state.serials.filter(s => s.status === 'sold' && !state.warranties.some(w => w.serialId === s.id && w.id !== $('warranty-id').value)).forEach(serial => {
    const item = state.items.find(item => item.id === serial.itemId), customer = state.customers.find(c => c.id === serial.customerId);
    select.append(new Option(`${item.name}｜${serial.serialNumber}｜${customer.name}`, serial.id));
  });
  select.value = state.serials.some(s => s.id === selected && s.status === 'sold' && !state.warranties.some(w => w.serialId === s.id && w.id !== $('warranty-id').value)) ? selected : '';
  select.parentElement.hidden = editing; select.required = !editing && requiresSerial(state.items.find(item => item.id === $('warranty-item').value));
  $('warranty-customer').disabled = !editing && Boolean(select.value);
  $('warranty-item').disabled = !editing && Boolean(select.value);
}
$('warranty-serial')?.addEventListener('change', () => {
  const serial = state.serials.find(s => s.id === $('warranty-serial').value && s.status === 'sold');
  if (serial) {
    $('warranty-customer').value = serial.customerId; $('warranty-item').value = serial.itemId;
    $('warranty-purchased-at').value = new Date(serial.soldAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  }
  renderWarrantySerials();
});
$('warranty-item')?.addEventListener('change', () => { $('warranty-serial').value = ''; renderWarrantySerials(); });

function resetWarrantyForm() {
  $('warranty-form').reset();
  $('warranty-id').value = '';
  $('warranty-form-title').textContent = '手動建立保固';
  $('warranty-customer').parentElement.hidden = false;
  $('warranty-item').parentElement.hidden = false;
  $('warranty-customer').required = true;
  $('warranty-item').required = true;
  $('warranty-purchased-at').value = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  $('warranty-cancel').hidden = true;
  $('warranty-serial').value = '';
  renderWarrantySerials();
  clearFormError('warranty-form');
}

function resetWarrantyCaseForm() {
  $('warranty-case-form').reset();
  $('warranty-case-id').value = '';
  $('warranty-case-form-title').textContent = '新增送修案件';
  $('warranty-case-cancel').hidden = true;
  clearFormError('warranty-case-form');
}

function selectWarranty(id) {
  if (selectedWarrantyId !== id) resetWarrantyCaseForm();
  selectedWarrantyId = id;
}

function renderWarrantyDetail() {
  const warranty = state.warranties.find((candidate) => candidate.id === selectedWarrantyId);
  const detail = $('warranty-detail');
  detail.hidden = !warranty;
  if (!warranty) return;
  const expired = warranty.expiresAt < new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  $('warranty-detail-summary').textContent = `${warranty.customerName}｜${warranty.itemName}｜條碼：${warranty.barcode || '—'}｜序號：${warranty.serialNumber || '未登錄'}｜購買：${warranty.purchasedAt}｜到期：${warranty.expiresAt}｜來源：${warranty.source === 'sale' ? `銷售 ${warranty.saleNumber}` : warranty.source === 'repair' ? '維修單' : '手動'}｜備註：${warranty.note || '—'}`;
  $('warranty-detail-status').textContent = expired ? '已到期：仍可建立案件，請評估是否符合保固。' : '有效中';
  $('warranty-detail-status').classList.toggle('low', expired);
  const list = $('warranty-case-list');
  list.replaceChildren();
  const labels = { pending: '待處理', in_progress: '處理中', completed: '已完成', not_covered: '不符保固' };
  const cases = state.warrantyCases.filter((entry) => entry.warrantyId === warranty.id);
  cases.forEach((entry) => {
    const row = document.createElement('tr');
    [entry.issue, labels[entry.status], entry.handledAt || '—', entry.resolutionNote || '—'].forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
    const actions = document.createElement('td');
    actions.className = 'actions';
    for (const [label, action] of [['編輯', 'edit'], ...(document.body.dataset.role === 'admin' ? [['刪除', 'delete']] : [])]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action === 'delete' ? 'danger' : 'secondary';
      button.dataset.caseAction = action;
      button.dataset.id = entry.id;
      button.textContent = label;
      actions.append(button);
    }
    row.append(actions);
    list.append(row);
  });
  if (!cases.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 5; cell.className = 'empty'; cell.textContent = '尚無送修案件。'; row.append(cell); list.append(row); }
  const replacements = $('warranty-replacement-list'); replacements.replaceChildren();
  state.transactions.filter(t => t.type === 'warranty_out' && t.warrantyId === warranty.id).forEach(transaction => {
    const row = document.createElement('tr');
    [new Date(transaction.createdAt).toLocaleString('zh-TW'), transaction.itemName, formatNumber(transaction.quantity), transaction.serialNumbers.join('、') || '不使用序號', transaction.expiresAt, transaction.note, transaction.createdByAccount].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
    replacements.append(row);
  });
  if (!replacements.children.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 7; cell.className = 'empty'; cell.textContent = '尚無出保固更換紀錄。'; row.append(cell); replacements.append(row); }
}

function renderWarranties() {
  renderWarrantySelectors();
  const warranties = warrantiesForFilter(state, { query: $('warranty-search').value, status: $('warranty-status').value });
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const list = $('warranty-list');
  list.replaceChildren();
  warranties.forEach((warranty) => {
    const expired = warranty.expiresAt < today;
    const row = document.createElement('tr');
    [warranty.customerName, warranty.itemName, `${warranty.barcode || '—'}｜序號：${warranty.serialNumber || '未登錄'}`, warranty.expiresAt, expired ? '已到期' : '有效中'].forEach((value, index) => { const cell = document.createElement('td'); cell.textContent = value; if (index === 4 && expired) cell.className = 'low'; row.append(cell); });
    const actions = document.createElement('td');
    actions.className = 'actions';
    for (const [label, action] of [['查看', 'view'], ['編輯', 'edit'], ...(document.body.dataset.role === 'admin' && warranty.source !== 'repair' ? [['刪除', 'delete']] : [])]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action === 'delete' ? 'danger' : 'secondary';
      button.dataset.warrantyAction = action;
      button.dataset.id = warranty.id;
      button.textContent = label;
      actions.append(button);
    }
    row.append(actions);
    list.append(row);
  });
  if (!warranties.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 6; cell.className = 'empty'; cell.textContent = '沒有符合條件的保固紀錄。'; row.append(cell); list.append(row); }
  renderWarrantyDetail();
}

$('warranty-search')?.addEventListener('input', renderWarranties);
$('warranty-status')?.addEventListener('change', renderWarranties);
$('warranty-cancel')?.addEventListener('click', resetWarrantyForm);
$('warranty-case-cancel')?.addEventListener('click', resetWarrantyCaseForm);

$('warranty-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const id = $('warranty-id').value;
    const fields = { purchasedAt: $('warranty-purchased-at').value, expiresAt: $('warranty-expires-at').value, note: $('warranty-note').value };
    const next = id ? updateWarranty(state, id, fields) : createWarranty(state, { ...fields, customerId: $('warranty-customer').value, itemId: $('warranty-item').value, serialId: $('warranty-serial').value, createdBy: currentUser?.id });
    if (!await saveState(next)) return;
    selectWarranty(id || next.warranties.at(-1).id);
    resetWarrantyForm();
    render();
    setStatus(id ? '保固已更新。' : '保固已建立。');
  } catch (error) { showFormError('warranty-form', error.message); }
});

$('warranty-list')?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-warranty-action]');
  const warranty = state.warranties.find((candidate) => candidate.id === button?.dataset.id);
  if (!warranty) return;
  const action = button.dataset.warrantyAction;
  if (action === 'delete') {
    if (document.body.dataset.role !== 'admin' || !confirm(`確定刪除「${warranty.customerName}／${warranty.itemName}」保固及其所有送修案件？`)) return;
    try {
      if (!await saveState(deleteWarranty(state, warranty.id))) return;
      if (selectedWarrantyId === warranty.id) selectWarranty('');
      resetWarrantyForm(); render(); setStatus('保固及相關案件已刪除。');
    } catch (error) { setStatus(error.message, true); }
    return;
  }
  selectWarranty(warranty.id);
  renderWarrantyDetail();
  if (action === 'edit') {
    $('warranty-id').value = warranty.id;
    $('warranty-customer').parentElement.hidden = true;
    $('warranty-item').parentElement.hidden = true;
    $('warranty-customer').required = false;
    $('warranty-item').required = false;
    $('warranty-purchased-at').value = warranty.purchasedAt;
    $('warranty-expires-at').value = warranty.expiresAt;
    $('warranty-note').value = warranty.note;
    $('warranty-form-title').textContent = `編輯：${warranty.itemName}`;
    $('warranty-cancel').hidden = false;
    renderWarrantySerials();
    $('warranty-purchased-at').focus();
  } else $('warranty-detail').scrollIntoView({ block: 'start' });
});

$('warranty-case-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const id = $('warranty-case-id').value;
    const fields = { issue: $('warranty-case-issue').value, status: $('warranty-case-status').value, handledAt: $('warranty-case-handled-at').value, resolutionNote: $('warranty-case-resolution-note').value };
    if (id && !state.warrantyCases.some((entry) => entry.id === id && entry.warrantyId === selectedWarrantyId)) throw new Error('案件不屬於目前保固，請重新選取。');
    const next = id ? updateWarrantyCase(state, id, fields) : addWarrantyCase(state, { ...fields, warrantyId: selectedWarrantyId, createdBy: currentUser?.id });
    if (!await saveState(next)) return;
    resetWarrantyCaseForm(); render(); setStatus(id ? '案件已更新。' : '案件已建立。');
  } catch (error) { showFormError('warranty-case-form', error.message); }
});

$('warranty-case-list')?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-case-action]');
  const warrantyCase = state.warrantyCases.find((candidate) => candidate.id === button?.dataset.id && candidate.warrantyId === selectedWarrantyId);
  if (!warrantyCase) return;
  if (button.dataset.caseAction === 'delete') {
    if (document.body.dataset.role !== 'admin' || !confirm(`確定刪除這筆送修案件「${warrantyCase.issue}」？`)) return;
    try {
      if (!await saveState(deleteWarrantyCase(state, warrantyCase.id))) return;
      resetWarrantyCaseForm(); render(); setStatus('案件已刪除。');
    } catch (error) { setStatus(error.message, true); }
    return;
  }
  $('warranty-case-id').value = warrantyCase.id;
  $('warranty-case-issue').value = warrantyCase.issue;
  $('warranty-case-status').value = warrantyCase.status;
  $('warranty-case-handled-at').value = warrantyCase.handledAt;
  $('warranty-case-resolution-note').value = warrantyCase.resolutionNote;
  $('warranty-case-form-title').textContent = '編輯送修案件';
  $('warranty-case-cancel').hidden = false;
  $('warranty-case-issue').focus();
});

function renderSalePicker() {
  const category = $('sale-category').value, select = $('sale-item'), selected = select.value;
  const items = state.items.filter(item => item.category === category);
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = !category ? '請先選擇分類' : items.length ? '請選擇品項' : '此分類尚無品項';
  select.append(placeholder);
  items.forEach(item => {
    const available = item.stock - (saleCart.find(line => line.itemId === item.id)?.quantity ?? 0);
    const option = document.createElement('option'); option.value = item.id;
    option.textContent = `${item.name}｜${item.sku || ''}｜售價 ${formatNumber(item.price)}｜可售 ${formatNumber(available)}${available <= 0 ? '（無可售庫存）' : ''}`;
    option.disabled = available <= 0; select.append(option);
    if (item.id === selected && available > 0) select.value = selected;
  });
  select.disabled = !items.length;
  $('sale-pick-add').disabled = !select.value;
  $('sale-picker-hint').textContent = !category ? '先選分類，再選品項加入購物車。' : !items.length ? '此分類尚無品項，請選擇其他分類。' : '可售數量已扣除購物車中的數量；無庫存品項不可加入。';
}
function renderSaleSerialSelector(item) {
  const panel = $('sale-serial-panel'); panel.hidden = !requiresSerial(item);
  if (!requiresSerial(item)) return;
  const select = $('sale-serial-ids'), selected = new Set(Array.from(select.selectedOptions, option => option.value));
  const occupied = new Set(saleCart.flatMap(line => line.serialIds || []));
  select.replaceChildren();
  const stock = state.serials.filter(s => s.itemId === item.id && s.status === 'in_stock');
  stock.filter(s => !occupied.has(s.id)).forEach(serial => {
    const option = document.createElement('option'); option.textContent = serial.serialNumber; option.value = serial.id; option.selected = selected.has(serial.id); select.append(option);
  });
  const complete = Number.isSafeInteger(item.stock) && stock.length === item.stock;
  $('sale-serial-hint').textContent = !complete ? `${item.name} 尚未補齊序號或庫存須更正，請店長先到庫存管理處理。` : `${item.name}｜本次加入 ${saleSerialQuantity} 件，請選 ${saleSerialQuantity} 個序號。已選 ${select.selectedOptions.length} 個；序號商品結帳必須指定客戶。`;
  $('sale-serial-add').disabled = !complete;
}
function beginSaleSerialSelection(item, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return showFormError('sale-form', '請輸入正確數量。');
  if (saleSerialItemId !== item.id) $('sale-serial-ids').replaceChildren();
  saleSerialItemId = item.id; saleSerialQuantity = quantity;
  renderSaleSerialSelector(item); $('sale-serial-scan').focus();
}
function addSaleItem(item, quantity, serialIds = []) {
  if (!item || !Number.isInteger(quantity) || quantity <= 0) { showFormError('sale-form', '請選擇品項並輸入正確數量。'); return false; }
  const existing = saleCart.find(line => line.itemId === item.id);
  const serials = serialIds.map(id => state.serials.find(s => s.id === id && s.itemId === item.id && s.status === 'in_stock'));
  if (requiresSerial(item) && (!Number.isSafeInteger(item.stock) || state.serials.filter(s => s.itemId === item.id && s.status === 'in_stock').length !== item.stock || serials.length !== quantity || serials.some(s => !s) || new Set(serialIds).size !== serialIds.length || saleCart.some(line => (line.serialIds || []).some(id => serialIds.includes(id))))) {
    showFormError('sale-form', '請先補齊庫存序號，並選擇數量相符、未重複的在庫序號。'); return false;
  }
  if (!requiresSerial(item) && serialIds.length) { showFormError('sale-form', '此品項不使用序號管理。'); return false; }
  if ((existing?.quantity ?? 0) + quantity > item.stock) { showFormError('sale-form', `庫存不足：${item.name}`); return false; }
  if (existing) { existing.quantity += quantity; existing.subtotal = existing.quantity * existing.unitPrice; existing.serialIds.push(...serialIds); existing.serialNumbers.push(...serials.map(s => s.serialNumber)); }
  else saleCart.push({ itemId: item.id, barcode: item.barcode, itemName: item.name, unitPrice: item.price, quantity, subtotal: item.price * quantity, serialIds: [...serialIds], serialNumbers: serials.map(s => s.serialNumber) });
  saleCheckoutId = '';
  clearFormError('sale-form'); renderSaleCart(); renderSalePicker(); renderSaleSerialSelector(state.items.find(item => item.id === saleSerialItemId)); return true;
}
function showSaleItem(item) { const info = $('sale-item-info'); info.textContent = `${item.name}｜庫存：${formatNumber(item.stock)}｜售價：${formatNumber(item.price)}`; info.hidden = false; }
function renderSaleCart() {
  const list = $('sale-cart'); if (!list) return; list.replaceChildren();
  if (!saleCart.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 5; cell.className = 'empty'; cell.textContent = '購物車目前沒有品項。請掃描或輸入 QR Code 後加入。'; row.append(cell); list.append(row); }
  // 特惠組合：先依購物車調整套用的組數，再取得各品項分到的折扣（分）。
  const promotions = globalThis.PromotionUI?.checkout;
  if (promotions?.sync()) saleCheckoutId = '';
  const { discount, byItem } = promotions?.summary() ?? { discount: 0, byItem: new Map() };
  saleCart.forEach((line, index) => {
    const row = document.createElement('tr');
    // 品名一行；有序號時在下一行用小字列出，避免和品名擠在一起。
    const nameCell = document.createElement('td'); nameCell.textContent = line.itemName;
    if (line.serialNumbers?.length) { const serials = document.createElement('small'); serials.className = 'sale-serials'; serials.textContent = `序號：${line.serialNumbers.join('、')}`; nameCell.append(serials); }
    row.append(nameCell);
    [`NT$ ${formatNumber(line.unitPrice)}`, formatNumber(line.quantity), `NT$ ${formatNumber(line.subtotal)}`].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
    const lineDiscount = (byItem.get(line.itemId) ?? 0) / 100;
    if (lineDiscount) { const note = document.createElement('small'); note.className = 'sale-line-discount'; note.textContent = `組合折 −NT$ ${formatNumber(lineDiscount)}`; row.lastChild.append(note); }
    const cell = document.createElement('td'), button = document.createElement('button'); button.type = 'button'; button.className = 'danger'; button.dataset.saleRemove = String(index); button.textContent = '移除'; cell.append(button); row.append(cell); list.append(row);
  });
  const gross = saleCart.reduce((sum, line) => sum + line.subtotal, 0);
  if ($('sale-cart-breakdown')) {
    $('sale-cart-breakdown').hidden = !discount;
    $('sale-cart-gross').textContent = formatNumber(gross);
    $('sale-cart-discount').textContent = formatNumber(discount);
  }
  $('sale-cart-total').textContent = formatNumber(Math.round((gross - discount) * 100) / 100);
}
function selectSaleSerial(serialNumber) {
  const select = $('sale-serial-ids');
  const serial = state.serials.find((entry) => entry.itemId === saleSerialItemId && entry.serialNumber === serialNumber && entry.status === 'in_stock');
  const option = Array.from(select.options).find((entry) => entry.value === serial?.id);
  if (!option || option.selected) return showFormError('sale-form', '找不到可選序號，或序號已被選取／加入購物車。');
  option.selected = true;
  renderSaleSerialSelector(state.items.find(item => item.id === saleSerialItemId));
}
function handleSaleScan(decodedText) {
  $('sale-barcode').value = String(decodedText || '').trim();
  const scan = parseUnitQr($('sale-barcode').value);
  if (!state.items.some((item) => item.barcode === scan.barcode)) {
    showFormError('sale-form', '找不到此 QR Code 對應的品項。');
    return false;
  }
  addSaleLine();
  return true;
}
function addSaleLine() { const scan = parseUnitQr($('sale-barcode').value); const item = scan.barcode && state.items.find(candidate => candidate.barcode === scan.barcode); if (requiresSerial(item)) { beginSaleSerialSelection(item, Number($('sale-quantity').value)); if (scan.serialNumber) selectSaleSerial(scan.serialNumber); return; } if (!addSaleItem(item, Number($('sale-quantity').value))) return; $('sale-barcode').value = ''; $('sale-quantity').value = '1'; $('sale-item-info').hidden = true; $('sale-barcode').focus(); }
$('sale-barcode')?.addEventListener('keydown', (event) => { if (event.key !== 'Enter') return; event.preventDefault(); handleSaleScan(event.currentTarget.value); });
$('sale-add')?.addEventListener('click', addSaleLine);
$('sale-category')?.addEventListener('change', () => { $('sale-item').value = ''; $('sale-pick-quantity').value = '1'; renderSalePicker(); });
$('sale-item')?.addEventListener('change', renderSalePicker);
$('sale-pick-add')?.addEventListener('click', () => {
  const item = state.items.find(candidate => candidate.id === $('sale-item').value && candidate.category === $('sale-category').value);
  if (requiresSerial(item)) return beginSaleSerialSelection(item, Number($('sale-pick-quantity').value));
  if (addSaleItem(item, Number($('sale-pick-quantity').value))) $('sale-pick-quantity').value = '1';
});
$('sale-cart')?.addEventListener('click', (event) => { const button = event.target.closest('button[data-sale-remove]'); if (!button) return; saleCart.splice(Number(button.dataset.saleRemove), 1); saleCheckoutId = ''; renderSaleCart(); renderSalePicker(); renderSaleSerialSelector(state.items.find(item => item.id === saleSerialItemId)); });
$('sale-serial-ids')?.addEventListener('change', () => renderSaleSerialSelector(state.items.find(item => item.id === saleSerialItemId)));
$('sale-serial-scan')?.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const select = $('sale-serial-ids'), value = event.currentTarget.value.trim();
  const serial = state.serials.find(s => s.itemId === saleSerialItemId && s.serialNumber === value && s.status === 'in_stock');
  const option = Array.from(select.options).find(option => option.value === serial?.id);
  if (!option || option.selected) return showFormError('sale-form', '找不到可選序號，或序號已被選取／加入購物車。');
  option.selected = true; event.currentTarget.value = ''; clearFormError('sale-form'); renderSaleSerialSelector(state.items.find(item => item.id === saleSerialItemId));
});
$('sale-serial-add')?.addEventListener('click', () => {
  const item = state.items.find(item => item.id === saleSerialItemId);
  if (!addSaleItem(item, saleSerialQuantity, Array.from($('sale-serial-ids').selectedOptions, option => option.value))) return;
  saleSerialItemId = ''; $('sale-serial-panel').hidden = true;
  $('sale-barcode').value = ''; $('sale-quantity').value = '1'; $('sale-pick-quantity').value = '1'; $('sale-barcode').focus();
});
if ($('sale-form')) $('sale-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pendingSave) return;
  const finishSale = (message) => {
    saleCart = []; saleCheckoutId = ''; saleSerialItemId = ''; saleSerialQuantity = 1;
    window.PromotionUI?.checkout?.reset();
    $('sale-form').reset(); $('sale-quantity').value = '1'; $('sale-pick-quantity').value = '1';
    $('sale-serial-panel').hidden = true; $('sale-serial-ids').replaceChildren(); $('sale-item-info').hidden = true;
    clearFormError('sale-form'); renderSaleCart(); render(); setStatus(message);
  };
  const committed = () => (state.sales ?? []).some(sale => sale.checkoutId === saleCheckoutId);
  try {
    saleCheckoutId ||= crypto.randomUUID();
    // 上一次送出其實已在雲端完成（畫面已重新讀取到這張單）：直接收尾，不再送一次。
    if (committed()) { finishSale('此筆銷售先前已完成，未重複扣庫存。'); return; }
    const next = recordSaleBatch(state, { lines: saleCart, checkoutId: saleCheckoutId, customerId: $('sale-customer').value, salespersonId: $('sale-salesperson').value, promotions: window.PromotionUI?.checkout?.selected() ?? [], createdBy: currentUser?.id, createdByAccount: currentUser?.displayName || currentUser?.username || currentUser?.id });
    if (!await saveState(next)) {
      if (committed()) finishSale('連線中斷，但雲端已確認此筆銷售完成，未重複扣庫存。');
      return;
    }
    finishSale('銷售已完成。');
  } catch (error) { showFormError('sale-form', error.message); }
});
function renderMonthlySales(refreshPerformance = false) {
  const monthInput = $('monthly-sales-month');
  const month = monthInput.value || new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
  if (!monthInput.value) monthInput.value = month;
  if (refreshPerformance) {
    renderMonthlySales.assignmentMonth = '';
    renderMonthlySales.assignments = null;
    renderMonthlySales.assignmentError = '';
  }
  const sales = salesForMonth(state, month);
  const isAdmin = document.body.dataset.role === 'admin';
  $('monthly-salesperson-heading').hidden = !isAdmin;
  $('monthly-assignment-heading').hidden = !isAdmin;
  const list = $('monthly-sales-list');
  list.replaceChildren();
  const seenSales = new Set();
  sales.forEach((sale) => {
    const row = document.createElement('tr');
    [new Date(sale.createdAt).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }), sale.itemName, sale.barcode, `NT$ ${formatNumber(sale.unitPrice)}`, formatNumber(sale.quantity), `NT$ ${formatNumber(sale.subtotal)}`, ...(isAdmin ? [sale.createdByAccount || '—'] : [])].forEach((value, index) => {
      const cell = document.createElement('td'); cell.textContent = value; cell.dataset.label = ['日期', '品項', '條碼', '單價', '數量', '小計', '結帳人'][index]; row.append(cell);
    });
    // 小計是折扣後實收；有特惠組合折扣時在下方註明。
    if (sale.discount > 0) { const note = document.createElement('small'); note.className = 'sale-line-discount'; note.textContent = `組合折 −NT$ ${formatNumber(sale.discount)}`; row.children[5].append(note); }
    if (isAdmin) {
      const cell = document.createElement('td');
      cell.dataset.label = '業務員歸屬';
      if (seenSales.has(sale.saleNumber)) cell.textContent = '—';
      else if (renderMonthlySales.assignmentMonth !== month) cell.textContent = '載入中…';
      else if (renderMonthlySales.assignmentError) cell.textContent = '無法載入歸屬';
      else {
        const assignment = renderMonthlySales.assignments?.get(sale.saleNumber);
        if (!assignment) cell.textContent = '無法確認銷售單';
        else if (assignment.salespersonId) cell.textContent = assignment.name;
        else {
          const people = state.salespeople.filter(person => person.active && person.isSales !== false);
          if (!people.length) cell.textContent = '請先啟用業務員';
          else {
            const select = document.createElement('select');
            select.setAttribute('aria-label', `銷售單 ${sale.saleNumber} 的業務員`);
            select.append(new Option('請選擇業務員', ''));
            people.forEach(person => select.append(new Option(person.name, person.id)));
            const button = document.createElement('button');
            button.type = 'button'; button.textContent = '補登'; button.dataset.assignSale = sale.saleNumber;
            button.addEventListener('click', async () => {
              if (document.body.dataset.role !== 'admin' || !select.value || button.disabled) return;
              button.disabled = true;
              try {
                await window.AppData.assignSaleSalesperson(sale.saleNumber, select.value);
                if (document.body.dataset.role === 'admin') {
                  setStatus('業務員已補登。');
                  await renderMonthlySales(true);
                }
              } catch (error) {
                setStatus(`補登失敗：${error.message}`, true);
                await renderMonthlySales(true);
              }
            });
            cell.append(select, button);
          }
        }
      }
      row.append(cell);
      seenSales.add(sale.saleNumber);
    }
    list.append(row);
  });
  if (!list.children.length) appendEmpty(list, '本月尚未有銷售紀錄。');
  $('monthly-sales-quantity').textContent = formatNumber(sales.reduce((sum, sale) => sum + sale.quantity, 0));
  $('monthly-sales-total').textContent = formatNumber(sales.reduce((sum, sale) => sum + sale.subtotal, 0));
  $('monthly-sales-count').textContent = formatNumber(new Set(sales.map((sale, index) => sale.saleNumber ?? sale.id ?? index)).size);
  // 較上月、趨勢圖、熱銷品項（店長專用）透過掛勾呼叫，讓只載入本函式的測試不受影響。
  renderMonthlySales.renderOverview?.(month, isAdmin);
  const panel = $('monthly-performance-panel');
  panel.hidden = !isAdmin;
  if (!isAdmin) {
    renderMonthlySales.requestId = (renderMonthlySales.requestId ?? 0) + 1;
    renderMonthlySales.loadedMonth = '';
    renderMonthlySales.assignmentMonth = '';
    renderMonthlySales.assignments = null;
    $('monthly-performance-list').replaceChildren();
    $('monthly-performance-status').textContent = '';
    return;
  }
  if (!refreshPerformance && (typeof currentPage !== 'function' || currentPage() !== 'monthly-sales' || renderMonthlySales.loadedMonth === month)) return;
  if (!window.AppData?.loadMonthlySalespersonPerformance || !window.AppData?.loadMonthlySaleAssignments) return;
  renderMonthlySales.loadedMonth = month;
  const requestId = renderMonthlySales.requestId = (renderMonthlySales.requestId ?? 0) + 1;
  const rows = $('monthly-performance-list');
  rows.replaceChildren();
  $('monthly-performance-status').textContent = '載入業務員績效中…';
  return Promise.all([window.AppData.loadMonthlySalespersonPerformance(month), window.AppData.loadMonthlySaleAssignments(month)]).then(([performance, assignments]) => {
    if (requestId !== renderMonthlySales.requestId || document.body.dataset.role !== 'admin' || monthInput.value !== month) return;
    renderMonthlySales.assignmentMonth = month;
    renderMonthlySales.assignments = new Map(assignments.map(value => [value.saleNumber, value]));
    // 業務員績效只算銷售；維修成果改由「分紅管理」的維修人員報表查看。
    performance.forEach(person => {
      const row = document.createElement('tr');
      [person.name, formatNumber(person.quantity), `NT$ ${formatNumber(person.total)}`].forEach((value, index) => { const cell = document.createElement('td'); cell.textContent = value; cell.dataset.label = ['業務員', '售出件數', '銷售金額'][index]; row.append(cell); });
      rows.append(row);
    });
    $('monthly-performance-status').textContent = performance.length ? '' : '本月尚無已歸屬的業務員銷售。';
    renderMonthlySales();
  }).catch((error) => {
    if (requestId !== renderMonthlySales.requestId || document.body.dataset.role !== 'admin') return;
    renderMonthlySales.assignmentMonth = month;
    renderMonthlySales.assignmentError = error.message;
    $('monthly-performance-status').textContent = `無法載入業務員績效：${error.message}`;
    renderMonthlySales();
  });
}
$('monthly-sales-month')?.addEventListener('change', () => renderMonthlySales(true));
// 營運總覽的店長區塊：由已載入的銷售資料計算，不另外查詢資料庫。
function dashboardChangeText(value) {
  if (value === null) return '上月無資料';
  const rounded = Math.round(value * 10) / 10;
  return `較上月 ${rounded > 0 ? '+' : ''}${formatNumber(rounded)}%`;
}
function renderMonthlyOverview(month, isAdmin) {
  const chart = $('monthly-trend');
  const top = $('monthly-top-items');
  const motorcycleChart = $('monthly-motorcycle-chart');
  const monthList = $('monthly-months-list');
  for (const id of ['monthly-trend-panel', 'monthly-top-panel', 'monthly-motorcycle-panel', 'monthly-months-panel', 'monthly-detail-back']) $(id).hidden = !isAdmin;
  // 店長先看各月清單，點選月份後才顯示明細；店員維持直接看當月明細。
  const showDetail = !isAdmin || renderMonthlySales.detailMonth === month;
  $('monthly-detail-panel').hidden = !showDetail;
  $('monthly-months-panel').hidden = !isAdmin || showDetail;
  $('monthly-detail-title').textContent = isAdmin ? `${month} 銷售明細` : '銷售明細';
  for (const key of ['total', 'quantity', 'count']) $(`monthly-sales-${key}-change`).hidden = !isAdmin;
  if (!isAdmin) {
    // 店員看不到這些區塊，也不保留先前店長畫面的內容。
    chart.replaceChildren(); top.replaceChildren(); motorcycleChart.replaceChildren(); monthList.replaceChildren();
    for (const key of ['total', 'quantity', 'count']) $(`monthly-sales-${key}-change`).textContent = '';
    return;
  }
  let summary;
  try { summary = dashboardSummary(state, month); } catch (error) { setStatus(`無法計算營運總覽：${error.message}`, true); return; }
  for (const key of ['total', 'quantity', 'count']) {
    const change = $(`monthly-sales-${key}-change`);
    const value = summary.change[key];
    change.textContent = dashboardChangeText(value);
    change.dataset.trend = value === null ? 'none' : value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  }
  // 長條圖：高度以期間最大值為 100%，全為 0 時只顯示 0。
  chart.replaceChildren();
  const max = Math.max(0, ...summary.trend.map(point => point.total));
  summary.trend.forEach(point => {
    const column = document.createElement('div');
    column.className = 'dashboard-bar-column';
    if (point.month === month) column.classList.add('current');
    const value = document.createElement('span'); value.className = 'dashboard-bar-value'; value.textContent = formatNumber(point.total);
    // 手機上欄位窄，改顯示「12.7萬」這種短格式（CSS 讀 data-short），避免數字斷成兩行。
    value.dataset.short = point.total >= 10000 ? `${(point.total / 10000).toFixed(1).replace(/\.0$/, '')}萬` : formatNumber(point.total);
    const track = document.createElement('div'); track.className = 'dashboard-bar-track';
    const bar = document.createElement('div'); bar.className = 'dashboard-bar';
    bar.setAttribute('style', `height: ${max ? point.total / max * 100 : 0}%`);
    track.append(bar);
    const label = document.createElement('span'); label.className = 'dashboard-bar-label'; label.textContent = `${Number(point.month.slice(5))}月`;
    column.append(value, track, label);
    chart.append(column);
  });
  chart.setAttribute('aria-label', `近 6 個月銷售額：${summary.trend.map(point => `${point.month} ${formatNumber(point.total)}`).join('、')}`);
  top.replaceChildren();
  summary.topItems.forEach((item, index) => {
    const row = document.createElement('tr');
    [String(index + 1), item.name, formatNumber(item.quantity), `NT$ ${formatNumber(item.total)}`].forEach((value, column) => {
      const cell = document.createElement('td'); cell.textContent = value; cell.dataset.label = ['排名', '品項', '售出件數', '銷售金額'][column]; row.append(cell);
    });
    top.append(row);
  });
  if (!summary.topItems.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 4; cell.className = 'empty'; cell.textContent = '本月尚未有銷售紀錄。';
    row.append(cell); top.append(row);
  }
  // 機車排名橫條圖：長度以第一名台數為 100%。
  motorcycleChart.replaceChildren();
  const topQuantity = summary.motorcycles[0]?.quantity ?? 0;
  summary.motorcycles.forEach((entry, index) => {
    const row = document.createElement('div'); row.className = 'dashboard-hbar-row';
    const name = document.createElement('span'); name.className = 'dashboard-hbar-name'; name.textContent = `${index + 1}. ${entry.name}`;
    const track = document.createElement('div'); track.className = 'dashboard-hbar-track';
    const bar = document.createElement('div'); bar.className = 'dashboard-hbar-bar';
    bar.setAttribute('style', `width: ${topQuantity ? entry.quantity / topQuantity * 100 : 0}%`);
    track.append(bar);
    const value = document.createElement('span'); value.className = 'dashboard-hbar-value'; value.textContent = `${formatNumber(entry.quantity)} 台｜NT$ ${formatNumber(entry.total)}`;
    row.append(name, track, value);
    motorcycleChart.append(row);
  });
  if (!summary.motorcycles.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '本月尚未售出機車。'; motorcycleChart.append(empty); }
  motorcycleChart.setAttribute('aria-label', summary.motorcycles.length ? `本月機車銷售排名：${summary.motorcycles.map(entry => `${entry.name} ${formatNumber(entry.quantity)} 台`).join('、')}` : '本月尚未售出機車');
  monthList.replaceChildren();
  summary.months.forEach(entry => {
    const row = document.createElement('tr');
    if (entry.month === month) row.className = 'current';
    [entry.month, `NT$ ${formatNumber(entry.total)}`, formatNumber(entry.count), formatNumber(entry.quantity)].forEach((value, column) => {
      const cell = document.createElement('td'); cell.textContent = value; cell.dataset.label = ['月份', '銷售額', '銷售筆數', '售出件數'][column]; row.append(cell);
    });
    const cell = document.createElement('td'); cell.dataset.label = '明細';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = '查看明細'; button.dataset.month = entry.month;
    cell.append(button); row.append(cell); monthList.append(row);
  });
  if (!summary.months.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 5; cell.className = 'empty'; cell.textContent = '尚未有銷售紀錄。';
    row.append(cell); monthList.append(row);
  }
}
renderMonthlySales.renderOverview = renderMonthlyOverview;
// 點「查看明細」：整頁切換到該月份並展開明細；「返回」回到各月清單。
$('monthly-months-list')?.addEventListener('click', (event) => {
  const month = event.target.closest?.('button[data-month]')?.dataset.month;
  if (!month || document.body.dataset.role !== 'admin') return;
  $('monthly-sales-month').value = month;
  renderMonthlySales.detailMonth = month;
  renderMonthlySales(true);
  $('monthly-detail-panel').scrollIntoView?.({ block: 'start', behavior: 'smooth' });
});
$('monthly-detail-back')?.addEventListener('click', () => {
  renderMonthlySales.detailMonth = '';
  renderMonthlySales();
});

async function resetAppSession() {
  appSessionEpoch++;
  window.RepairUI?.instance?.clear();
  window.BonusUI?.instance?.clear();
  window.PromotionUI?.instance?.clear();
  window.PromotionUI?.checkout?.clear();
  window.PromotionUI?.quotation?.clear();
  renderMonthlySales.requestId = (renderMonthlySales.requestId ?? 0) + 1;
  renderMonthlySales.loadedMonth = '';
  renderMonthlySales.assignmentMonth = '';
  renderMonthlySales.assignments = null;
  renderMonthlySales.assignmentError = '';
  $('monthly-trend')?.replaceChildren();
  renderMonthlySales.detailMonth = '';
  currentUser = null;
  setAppEnabled(false);
  window.StaffUI?.stop();
  try { await pendingSave; } catch { /* The save path already reports the failure. */ }
  state = emptyState();saleCart = [];saleCheckoutId = '';quotationLines = [];hourlyRate = 0;purchaseLines = [];
  saleSerialItemId = ''; saleSerialQuantity = 1;
  receiptPurchaseId = ''; receiptSerialNumbersByItem = {};
  purchaseSupplierId = '';selectedPurchaseId = '';selectedWarrantyId = '';purchaseBusy = false;
  document.querySelectorAll('#app-shell form').forEach(form => form.reset());
  document.querySelectorAll('#app-shell input[type="hidden"]').forEach(input => { input.value = ''; });
  document.querySelectorAll('#app-shell input[type="password"]').forEach(input => { input.value = ''; });
  for (const id of ['purchase-detail','quotation-detail','warranty-detail','staff-reset-panel','sale-item-info','sale-serial-panel','purchase-receipt-panel','transaction-warranty-fields']) if ($(id)) $(id).hidden = true;
  for (const id of ['sale-serial-ids', 'purchase-receipt-fields', 'warranty-serial', 'serial-item', 'transaction-serial-ids', 'transaction-warranty']) $(id)?.replaceChildren();
  document.querySelectorAll('#app-shell tbody').forEach(body => body.replaceChildren());
  setAppEnabled(false);
}

async function bootstrap(user, isCurrent = () => true) {
  try {
    currentUser = user;
    const result = window.AppData?.loadSnapshot ? await window.AppData.loadSnapshot(user) : await InventoryStorage.loadState();
    if (!isCurrent()) return;
    state = result.state;
    hourlyRate = result.hourlyRate ?? 0;
    if ($('shop-hourly-rate')) $('shop-hourly-rate').value = String(hourlyRate);
    render();
    renderSaleCart();
    showPage(currentPage());
    setAppEnabled(!result.readonly);
    updateItemPrintButton();
    renderTransactionItems();
    resetWarrantyForm();
    if (result.readonly) setStatus('目前無法連線雲端，已開啟本機快取唯讀模式。', true, true);
    else if (result.migrated) setStatus('已完成首次資料遷移；舊版資料已保留作為備援。');
    await window.StaffUI?.start(user, {
      getSalespeople: () => state.salespeople,
      link: async (personId, authUserId) => {
        if (currentUser?.role !== 'admin') throw new Error('僅店長可連結登入帳號。');
        const person = state.salespeople.find(value => value.id === personId);
        if (!person) throw new Error('找不到本機業務。');
        if (!await saveState(updateSalesperson(state, personId, { ...person, authUserId }))) return false;
        render();return true;
      },
    });
  } catch (error) {
    setStatus(`資料庫讀取失敗：${error.message}。請確認瀏覽器儲存空間後重試。`, true, true);
  }
}

window.AppAuthUI.start(bootstrap, resetAppSession);
})();
