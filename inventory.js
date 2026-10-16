const categories = new Set(['機車', '零件', '用品', '電池']);
const transactionTypes = new Set(['in', 'out', 'adjust', 'warranty_out']);
const warrantyCaseStatuses = new Set(['pending', 'in_progress', 'completed', 'not_covered']);

function emptyState() {
  return { items: [], transactions: [], customers: [], salespeople: [], quotations: [], sales: [], warranties: [], warrantyCases: [], suppliers: [], purchases: [], serials: [] };
}

function requiresSerial(item) { return item?.category === '機車' || item?.category === '電池'; }
function serialStock(stock) {
  if (!Number.isSafeInteger(stock) || stock < 0) throw new Error('序號商品庫存須為安全非負整數，請先盤點更正。');
  return stock;
}
function normalizedSerial(value) {
  const status = value?.status;
  if (!['in_stock', 'sold', 'removed', 'warranty_out'].includes(status)) throw new Error('序號狀態無效');
  return { id: id(value?.id, '序號 ID'), itemId: id(value?.itemId, '序號品項'), serialNumber: id(value?.serialNumber, '原廠序號'), status,
    purchaseId: text(value?.purchaseId), createdAt: date(value?.createdAt, '序號建立日期'), createdBy: text(value?.createdBy),
    saleId: text(value?.saleId), customerId: text(value?.customerId), soldAt: text(value?.soldAt), warrantyId: text(value?.warrantyId),
    removedAt: text(value?.removedAt), removedBy: text(value?.removedBy), removalReason: text(value?.removalReason) };
}
function newSerials(state, item, serialNumbers = [], createdBy, purchaseId = '') {
  if (!Array.isArray(serialNumbers)) throw new Error('序號清單格式無效');
  if (!requiresSerial(item) && serialNumbers.length) throw new Error('此品項不使用序號管理');
  const numbers = serialNumbers.map(value => id(value, '原廠序號'));
  if (new Set(numbers).size !== numbers.length || numbers.some(value => state.serials.some(serial => serial.serialNumber === value))) throw new Error('原廠序號重複');
  return numbers.map(serialNumber => normalizedSerial({ id: crypto.randomUUID(), itemId: item.id, serialNumber, status: 'in_stock', createdAt: new Date().toISOString(), createdBy, purchaseId }));
}
function registerSerials(state, fields) {
  const current = validateState(state);
  const item = current.items.find(item => item.id === fields?.itemId);
  if (!item || !requiresSerial(item)) throw new Error('請選擇機車或電池品項');
  serialStock(item.stock);
  const added = newSerials(current, item, fields?.serialNumbers, fields?.createdBy);
  if (!added.length) throw new Error('請輸入原廠序號');
  return validateState({ ...current, serials: [...current.serials, ...added] });
}
function selectedSerials(state, item, serialIds = []) {
  if (!Array.isArray(serialIds) || new Set(serialIds).size !== serialIds.length) throw new Error('所選序號重複或格式無效');
  if (!requiresSerial(item) && serialIds.length) throw new Error('此品項不使用序號管理');
  return serialIds.map(serialId => {
    const serial = state.serials.find(s => s.id === serialId && s.itemId === item.id && s.status === 'in_stock');
    if (!serial) throw new Error('所選序號不是此品項的在庫實物');
    return serial;
  });
}
function requireCompleteSerials(state, item) {
  serialStock(item.stock);
  if (state.serials.filter(s => s.itemId === item.id && s.status === 'in_stock').length !== item.stock) throw new Error(`請先補齊在庫序號：${item.name}`);
}

function validateSerialRelations(serials, items, sales, customers, purchases, warranties, transactions) {
  if (new Set(sales.map(s => id(s.id, '銷售 ID'))).size !== sales.length) throw new Error('銷售 ID 重複');
  if (new Set(serials.map(s => s.id)).size !== serials.length || new Set(serials.map(s => s.serialNumber)).size !== serials.length) throw new Error('序號 ID 或原廠序號重複');
  for (const serial of serials) {
    const item = items.find(item => item.id === serial.itemId);
    if (!item || !requiresSerial(item)) throw new Error('序號品項無效');
    if (serial.purchaseId && !purchases.some(p => p.id === serial.purchaseId && p.status === 'received' && p.lines.some(l => l.itemId === item.id))) throw new Error('序號進貨關聯無效');
    if (serial.status === 'sold') {
      const sale = sales.find(s => s.id === serial.saleId);
      const index = sale?.serialIds.indexOf(serial.id) ?? -1;
      if (!sale || sale.itemId !== item.id || index < 0 || sale.serialNumbers[index] !== serial.serialNumber || !customers.some(c => c.id === serial.customerId)) throw new Error('序號銷售或客戶關聯無效');
      date(serial.soldAt, '售出日期');
      if (Date.parse(serial.soldAt) !== Date.parse(date(sale.createdAt, '銷售日期'))) throw new Error('序號售出日期與銷售不符');
    } else if (serial.status === 'warranty_out') {
      const warranty = warranties.find(w => w.id === serial.warrantyId);
      if (!warranty || warranty.customerId !== serial.customerId || serial.saleId || serial.soldAt || !transactions.some(t => t.type === 'warranty_out' && t.warrantyId === warranty.id && t.serialIds.includes(serial.id))) throw new Error('出保固序號關聯無效');
    } else if (serial.saleId || serial.customerId || serial.soldAt) throw new Error('未售序號不可有銷售關聯');
    if (serial.status !== 'warranty_out' && serial.warrantyId) throw new Error('非出保固序號不可有更換關聯');
    if (serial.status === 'removed' || serial.status === 'warranty_out') {
      date(serial.removedAt, '移出日期'); id(serial.removedBy, '移出操作者'); id(serial.removalReason, '移出原因');
    } else if (serial.removedAt || serial.removedBy || serial.removalReason) throw new Error('未移出序號不可有移出資料');
  }
  const issuedIds = new Set();
  for (const transaction of transactions.filter(t => t.type === 'warranty_out')) {
    const warranty = warranties.find(w => w.id === transaction.warrantyId);
    const item = items.find(item => item.id === transaction.itemId);
    if (!warranty || transaction.customerId !== warranty.customerId) throw new Error('出保固紀錄或客戶關聯無效');
    if (transaction.serialIds.length !== transaction.serialNumbers.length || transaction.serialIds.length !== (requiresSerial(item) ? transaction.quantity : 0)) throw new Error('出保固序號數量不符');
    transaction.serialIds.forEach((serialId, index) => {
      const serial = serials.find(s => s.id === serialId);
      if (issuedIds.has(serialId) || !serial || serial.status !== 'warranty_out' || serial.itemId !== item.id || serial.warrantyId !== warranty.id || serial.customerId !== warranty.customerId || serial.serialNumber !== transaction.serialNumbers[index] || Date.parse(serial.removedAt) !== Date.parse(transaction.createdAt) || serial.removedBy !== transaction.createdBy || serial.removalReason !== transaction.note) throw new Error('出保固實物序號關聯無效或重複');
      issuedIds.add(serialId);
    });
  }
  for (const purchase of purchases.filter(p => p.status === 'received')) {
    for (const line of purchase.lines) {
      if (serials.filter(s => s.purchaseId === purchase.id && s.itemId === line.itemId).length > line.quantity) throw new Error('進貨序號數超過收貨數量');
    }
  }
  for (const item of items.filter(requiresSerial)) {
    const count = serials.filter(s => s.itemId === item.id && s.status === 'in_stock').length;
    if (count > item.stock) throw new Error('在庫序號數超過庫存');
  }
  const soldIds = new Set();
  for (const sale of sales) {
    if (sale.serialIds.length !== sale.serialNumbers.length || (sale.serialIds.length && sale.serialIds.length !== sale.quantity)) throw new Error('銷售序號數量不符');
    sale.serialIds.forEach((serialId, index) => {
      if (soldIds.has(serialId) || !serials.some(s => s.id === serialId && s.status === 'sold' && s.saleId === sale.id && s.itemId === sale.itemId && s.serialNumber === sale.serialNumbers[index])) throw new Error('銷售序號關聯無效');
      soldIds.add(serialId);
    });
  }
  const warrantySerialIds = new Set();
  for (const warranty of warranties) {
    if (Boolean(warranty.serialId) !== Boolean(warranty.serialNumber)) throw new Error('保固序號資料不完整');
    if (!warranty.serialId) continue;
    const serial = serials.find(s => s.id === warranty.serialId);
    if (!serial || serial.status !== 'sold' || serial.itemId !== warranty.itemId || serial.customerId !== warranty.customerId || serial.serialNumber !== warranty.serialNumber || serial.saleId !== warranty.saleId || warrantySerialIds.has(serial.id)) throw new Error('保固序號關聯無效或重複');
    warrantySerialIds.add(serial.id);
  }
}

function inventoryCost(state) {
  return state.items.reduce((sum, item) => sum + item.cost * item.stock, 0);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${label}必須是零或正數`);
  return result;
}

function id(value, label) {
  const result = text(value);
  if (!result) throw new Error(`${label}無效`);
  return result;
}

function normalizedItem(value, fallbackId) {
  const name = text(value?.name);
  if (!name) throw new Error('品項名稱不可空白');
  if (!categories.has(value?.category)) throw new Error('品項分類無效');
  return {
    id: id(value?.id ?? fallbackId, '品項 ID'),
    name,
    category: value.category,
    supplierId: text(value.supplierId),
    voltage: value.category === '電池' && value.voltage != null && value.voltage !== '' ? number(value.voltage, '電壓') : null,
    capacity: value.category === '電池' && value.capacity != null && value.capacity !== '' ? number(value.capacity, '容量') : null,
    sku: text(value.sku),
    barcode: text(value.barcode),
    cost: number(value.cost, '成本'),
    price: number(value.price, '售價'),
    stock: number(value.stock, '庫存'),
    minimumStock: number(value.minimumStock, '最低庫存'),
    warrantyMonths: nonnegativeInteger(value.warrantyMonths ?? 0, '保固月數'),
    notes: text(value.notes),
  };
}

function normalizedTransaction(value, itemIds, fallbackId) {
  const itemId = id(value?.itemId, '品項 ID');
  if (!itemIds.has(itemId)) throw new Error('異動品項不存在');
  if (!transactionTypes.has(value?.type)) throw new Error('異動類型無效');
  const createdAt = text(value.createdAt);
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) throw new Error('異動日期無效');
  const transaction = {
    id: id(value?.id ?? fallbackId, '異動 ID'),
    itemId,
    type: value.type,
    quantity: number(value.quantity, '異動數量'),
    createdAt,
    note: text(value.note),
    purchaseId: text(value.purchaseId),
  };
  if (value.type === 'warranty_out') {
    if (!Array.isArray(value.serialIds) || !Array.isArray(value.serialNumbers)) throw new Error('出保固序號清單格式無效');
    Object.assign(transaction, { quantity: positiveInteger(value.quantity, '出保固數量'), warrantyId: id(value.warrantyId, '原保固'),
      customerId: id(value.customerId, '客戶'), customerName: id(value.customerName, '客戶姓名'), itemName: id(value.itemName, '更換品項'),
      expiresAt: calendarDate(value.expiresAt, '沿用保固到期日'), unitCostSnapshot: number(value.unitCostSnapshot, '出保固成本'),
      createdBy: id(value.createdBy, '操作帳號'), createdByAccount: text(value.createdByAccount) || text(value.createdBy), note: id(value.note, '出保固原因'),
      serialIds: value.serialIds.map(value => id(value, '出保固序號 ID')), serialNumbers: value.serialNumbers.map(value => id(value, '出保固序號')) });
  }
  return transaction;
}

function positiveInteger(value, label) {
  const result = number(value, label);
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${label}必須是大於零的整數`);
  return result;
}

function nonnegativeInteger(value, label) {
  const result = number(value, label);
  if (!Number.isInteger(result)) throw new Error(`${label}必須是非負整數`);
  return result;
}

function code128Modules(value) {
  const barcode = text(value);
  if (!/^\d{13}$/.test(barcode)) throw new Error('條碼必須是 13 碼數字（Code 128）');
  const patterns = '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ');
  // Pair encoding keeps the label compact; switch to B for the final odd digit.
  const symbols = [105, ...barcode.slice(0, 12).match(/../g).map(Number), 100, Number(barcode[12]) + 16];
  symbols.push(symbols.reduce((sum, symbol, index) => sum + symbol * (index || 1), 0) % 103, 106);
  return '0'.repeat(10) + symbols.map((symbol) => [...patterns[symbol]].map((width, index) => (index % 2 ? '0' : '1').repeat(Number(width))).join('')).join('') + '0'.repeat(10);
}

function date(value, label) {
  const result = text(value);
  if (!result || Number.isNaN(Date.parse(result))) throw new Error(`${label}無效`);
  return result;
}

function calendarDate(value, label) {
  const result = text(value);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new Error(`${label}無效`);
  return result;
}

function addMonths(value, months) {
  const [year, month, day] = value.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month + months, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

function taipeiDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type).value).join('-');
}

function normalizedWarranty(value) {
  for (const key of ['serialId', 'serialNumber']) {
    if (value?.[key] !== undefined && typeof value[key] !== 'string') throw new Error('保固序號格式無效');
  }
  const purchasedAt = calendarDate(value?.purchasedAt, '購買日期');
  const expiresAt = calendarDate(value?.expiresAt, '到期日期');
  if (expiresAt < purchasedAt) throw new Error('到期日期不可早於購買日期');
  const source = value?.source;
  if (source !== 'manual' && source !== 'sale') throw new Error('保固來源無效');
  return {
    id: id(value?.id, '保固 ID'), customerId: id(value?.customerId, '客戶 ID'),
    customerName: id(value?.customerName, '客戶姓名'), itemId: id(value?.itemId, '品項 ID'),
    itemName: id(value?.itemName, '品項名稱'), barcode: text(value?.barcode), source,
    saleId: text(value?.saleId), saleNumber: text(value?.saleNumber), serialId: text(value?.serialId), serialNumber: text(value?.serialNumber),
    purchasedAt, expiresAt, note: text(value?.note), createdBy: text(value?.createdBy),
    createdAt: date(value?.createdAt, '保固建立日期'),
  };
}

function normalizedWarrantyCase(value, warrantyIds) {
  const warrantyId = id(value?.warrantyId, '保固 ID');
  if (!warrantyIds.has(warrantyId)) throw new Error('保固不存在');
  if (!warrantyCaseStatuses.has(value?.status)) throw new Error('案件狀態無效');
  return {
    id: id(value?.id, '案件 ID'), warrantyId, issue: id(value?.issue, '故障說明'),
    status: value.status, handledAt: value?.handledAt ? calendarDate(value.handledAt, '處理日期') : '',
    resolutionNote: text(value?.resolutionNote), itemName: id(value?.itemName, '品項名稱'),
    purchasedAt: calendarDate(value?.purchasedAt, '購買日期'), expiresAt: calendarDate(value?.expiresAt, '到期日期'),
    createdBy: text(value?.createdBy), createdAt: date(value?.createdAt, '案件建立日期'),
    updatedAt: date(value?.updatedAt, '案件更新日期'),
  };
}

function memberNumber(value) {
  const result = text(value);
  if (!/^M\d{6}$/.test(result)) throw new Error('會員編號無效');
  return result;
}

function normalizedCustomer(value, fallbackId, fallbackMemberNumber) {
  const name = text(value?.name);
  const phone = text(value?.phone);
  if (!name) throw new Error('客戶姓名不可空白');
  if (!phone) throw new Error('客戶電話不可空白');
  return {
    id: id(value?.id ?? fallbackId, '客戶 ID'),
    memberNumber: memberNumber(value?.memberNumber ?? fallbackMemberNumber),
    name,
    phone,
    address: text(value?.address),
    note: text(value?.note),
    active: value?.active !== false,
    createdAt: date(value?.createdAt, '客戶建立日期'),
    updatedAt: date(value?.updatedAt, '客戶更新日期'),
  };
}

function normalizedSalesperson(value, fallbackId) {
  const name = text(value?.name);
  if (!name) throw new Error('業務姓名不可空白');
  return { id: id(value?.id ?? fallbackId, '業務 ID'), name, authUserId: text(value?.authUserId), active: value?.active !== false, createdAt: date(value?.createdAt, '業務建立日期'), updatedAt: date(value?.updatedAt, '業務更新日期') };
}

function normalizedQuotation(value, customerIds, salespersonIds, itemIds, fallbackId) {
  const customerId = id(value?.customerId, '客戶 ID');
  if (!customerIds.has(customerId)) throw new Error('報價客戶不存在');
  if (!Array.isArray(value?.lines) || !value.lines.length) throw new Error('報價至少需要一筆明細');
  const lines = value.lines.map((line) => {
    const itemId = id(line?.itemId, '品項 ID');
    if (!itemIds.has(itemId)) throw new Error('報價品項不存在');
    const quantity = positiveInteger(line?.quantity, '報價數量');
    const unitPrice = number(line?.unitPrice, '報價單價');
    const subtotal = number(line?.subtotal, '報價小計');
    if (subtotal !== quantity * unitPrice) throw new Error('報價小計無效');
    const itemName = text(line?.itemName);
    if (!itemName) throw new Error('報價品項名稱不可空白');
    return { itemId, itemName, quantity, unitPrice, subtotal };
  });
  const total = number(value?.total, '報價總額');
  if (total !== lines.reduce((sum, line) => sum + line.subtotal, 0)) throw new Error('報價總額無效');
  const numberValue = text(value?.number);
  const customerName = text(value?.customerName);
  const customerPhone = text(value?.customerPhone);
  if (!numberValue || !customerName || !customerPhone) throw new Error('報價資料不完整');
  const salespersonId = text(value?.salespersonId);
  const salespersonName = text(value?.salespersonName);
  if ((salespersonId || salespersonName) && (!salespersonId || !salespersonName || !salespersonIds.has(salespersonId))) throw new Error('報價業務不存在');
  return {
    id: id(value?.id ?? fallbackId, '報價 ID'),
    number: numberValue,
    customerId,
    customerName,
    customerPhone,
    salespersonId,
    salespersonName,
    lines,
    total,
    note: text(value?.note),
    createdAt: date(value?.createdAt, '報價日期'),
  };
}

function validateState(value) {
  if (!value || !Array.isArray(value.items) || !Array.isArray(value.transactions)) {
    throw new Error('備份資料格式不正確');
  }
  if ((value.suppliers !== undefined && !Array.isArray(value.suppliers)) || (value.purchases !== undefined && !Array.isArray(value.purchases))) throw new Error('供應商或進貨資料格式不正確');
  const suppliers = (value.suppliers ?? []).map(normalizedSupplier);
  const supplierIds = new Set(suppliers.map((supplier) => supplier.id));
  if (supplierIds.size !== suppliers.length) throw new Error('供應商 ID 重複');
  const items = value.items.map((item) => normalizedItem(item));
  if (items.some((item) => item.supplierId && !supplierIds.has(item.supplierId))) throw new Error('品項供應商不存在');
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) throw new Error('品項 ID 重複');
  const barcodes = items.filter((item) => item.barcode).map((item) => item.barcode);
  if (new Set(barcodes).size !== barcodes.length) throw new Error('條碼重複');
  const transactions = value.transactions.map((transaction) => normalizedTransaction(transaction, ids));
  const transactionIds = new Set(transactions.map((transaction) => transaction.id));
  if (transactionIds.size !== transactions.length) throw new Error('異動 ID 重複');
  const customers = (value.customers ?? []).map((customer, index) => normalizedCustomer(customer, undefined, `M${String(index + 1).padStart(6, '0')}`));
  const customerIds = new Set(customers.map((customer) => customer.id));
  if (customerIds.size !== customers.length) throw new Error('客戶 ID 重複');
  const memberNumbers = new Set(customers.map((customer) => customer.memberNumber));
  if (memberNumbers.size !== customers.length) throw new Error('會員編號重複');
  const salespeople = (value.salespeople ?? []).map((salesperson) => normalizedSalesperson(salesperson));
  const salespersonIds = new Set(salespeople.map((salesperson) => salesperson.id));
  const linkedUsers = salespeople.map((salesperson) => salesperson.authUserId).filter(Boolean);
  if (new Set(linkedUsers).size !== linkedUsers.length) throw new Error('登入帳號已連結其他業務');
  if (salespersonIds.size !== salespeople.length) throw new Error('業務 ID 重複');
  const quotations = (value.quotations ?? []).map((quotation) => normalizedQuotation(quotation, customerIds, salespersonIds, ids));
  const quotationIds = new Set(quotations.map((quotation) => quotation.id));
  if (quotationIds.size !== quotations.length) throw new Error('報價 ID 重複');
  const quotationNumbers = new Set(quotations.map((quotation) => quotation.number));
  if (quotationNumbers.size !== quotations.length) throw new Error('報價編號重複');
  if (!Array.isArray(value.sales ?? []) || !Array.isArray(value.serials ?? [])) throw new Error('銷售或序號資料格式不正確');
  const sales = (value.sales ?? []).map(sale => {
    if (!sale || !Array.isArray(sale.serialIds ?? []) || !Array.isArray(sale.serialNumbers ?? [])) throw new Error('銷售序號格式無效');
    return { ...sale, serialIds: (sale.serialIds ?? []).map(value => id(value, '銷售序號 ID')), serialNumbers: (sale.serialNumbers ?? []).map(value => id(value, '銷售序號')) };
  });
  const serials = (value.serials ?? []).map(normalizedSerial);
  if (!Array.isArray(value.warranties ?? []) || !Array.isArray(value.warrantyCases ?? [])) throw new Error('保固資料格式不正確');
  const warranties = (value.warranties ?? []).map(normalizedWarranty);
  const warrantyIds = new Set(warranties.map((warranty) => warranty.id));
  if (warrantyIds.size !== warranties.length) throw new Error('保固 ID 重複');
  const warrantyCases = (value.warrantyCases ?? []).map((warrantyCase) => normalizedWarrantyCase(warrantyCase, warrantyIds));
  if (new Set(warrantyCases.map((warrantyCase) => warrantyCase.id)).size !== warrantyCases.length) throw new Error('案件 ID 重複');
  const purchases = (value.purchases ?? []).map((purchase) => normalizedPurchase(purchase, supplierIds, ids));
  if (new Set(purchases.map((purchase) => purchase.id)).size !== purchases.length || new Set(purchases.map((purchase) => purchase.number)).size !== purchases.length) throw new Error('進貨 ID 或單號重複');
  for (const transaction of transactions.filter((entry) => entry.purchaseId)) {
    const purchase = purchases.find((entry) => entry.id === transaction.purchaseId);
    const line = purchase?.lines.find((entry) => entry.itemId === transaction.itemId);
    if (!purchase || purchase.status !== 'received' || transaction.type !== 'in' || !line || line.quantity !== transaction.quantity) throw new Error('庫存異動的進貨關聯無效');
  }
  validateSerialRelations(serials, items, sales, customers, purchases, warranties, transactions);
  return { items, transactions, customers, salespeople, quotations, sales, warranties, warrantyCases, suppliers, purchases, serials };
}

function addItem(state, fields) {
  const current = validateState(state);
  const nextItem = normalizedItem(fields, crypto.randomUUID());
  validateBatterySpecs(nextItem);
  validateSupplierAssignment(current, nextItem);
  nextItem.name = batteryItemName(nextItem);
  if (!nextItem.sku) {
    const date = taipeiDate(new Date()).replaceAll('-', '');
    const prefix = nextItem.category === '電池'
      ? '88' + date.slice(0, 4) + String(nextItem.voltage).padStart(2, '0') + String(nextItem.capacity).padStart(2, '0')
      : { 機車: '11', 零件: '22', 用品: '33' }[nextItem.category] + date;
    const sequence = current.items.reduce((largest, item) => {
      return item.sku.startsWith(prefix) && /^\d{13}$/.test(item.sku) ? Math.max(largest, Number(item.sku.slice(-3))) : largest;
    }, 0) + 1;
    if (sequence > 999) throw new Error('此編碼組合料號已達 999 筆，無法再新增。');
    nextItem.sku = prefix + String(sequence).padStart(3, '0');
    if (!nextItem.barcode) nextItem.barcode = nextItem.sku;
  }
  const added = newSerials(current, nextItem, fields.serialNumbers, fields.createdBy);
  if (requiresSerial(nextItem) && added.length !== serialStock(nextItem.stock)) throw new Error('初始庫存與序號數量不符');
  return validateState({ ...current, items: [...current.items, nextItem], serials: [...current.serials, ...added] });
}

function updateItem(state, itemId, fields) {
  const current = validateState(state);
  if (!current.items.some((item) => item.id === itemId)) throw new Error('找不到品項');
  const nextItem = normalizedItem({ ...fields, id: itemId, sku: current.items.find((item) => item.id === itemId).sku });
  const existing = current.items.find(item => item.id === itemId);
  if (requiresSerial(existing) && nextItem.stock !== existing.stock) throw new Error('序號商品請使用盤點調整庫存');
  if (nextItem.category !== existing.category) {
    const hasHistory = current.transactions.some(t => t.itemId === itemId) || current.sales.some(s => s.itemId === itemId) || current.warranties.some(w => w.itemId === itemId) || current.purchases.some(p => p.lines.some(l => l.itemId === itemId)) || current.quotations.some(q => q.lines.some(l => l.itemId === itemId));
    if (current.serials.some(s => s.itemId === itemId) || ((requiresSerial(existing) || requiresSerial(nextItem)) && (existing.stock !== 0 || nextItem.stock !== 0 || hasHistory))) throw new Error('此品項有庫存或歷史紀錄，請另建品項，不可變更序號分類');
  }
  validateBatterySpecs(nextItem);
  validateSupplierAssignment(current, nextItem, current.items.find((item) => item.id === itemId).supplierId);
  nextItem.name = batteryItemName(nextItem);
  return validateState({ ...current, items: current.items.map((item) => item.id === itemId ? nextItem : item) });
}

function normalizedSupplier(value) {
  const taxId = text(value?.taxId);
  if (taxId && !/^\d{8}$/.test(taxId)) throw new Error('統編須為 8 碼數字');
  if (typeof value?.active !== 'boolean') throw new Error('供應商啟用狀態無效');
  return { id: id(value?.id, '供應商 ID'), name: id(value?.name, '供應商名稱'), contact: text(value?.contact), phone: text(value?.phone), address: text(value?.address), taxId, note: text(value?.note), active: value.active, createdAt: date(value?.createdAt, '建立日期'), updatedAt: date(value?.updatedAt, '更新日期') };
}

function validateSupplierAssignment(state, item, previousId = '') {
  if (!item.supplierId) return;
  const supplier = state.suppliers.find((candidate) => candidate.id === item.supplierId);
  if (!supplier) throw new Error('供應商不存在');
  if (!supplier.active && item.supplierId !== previousId) throw new Error('不能指定已停用供應商');
}

function addSupplier(state, fields) {
  const current = validateState(state);
  const timestamp = new Date().toISOString();
  const supplier = normalizedSupplier({ ...fields, id: crypto.randomUUID(), active: true, createdAt: timestamp, updatedAt: timestamp });
  return validateState({ ...current, suppliers: [...current.suppliers, supplier] });
}

function updateSupplier(state, supplierId, fields) {
  const current = validateState(state);
  const existing = current.suppliers.find((supplier) => supplier.id === supplierId);
  if (!existing) throw new Error('找不到供應商');
  const next = normalizedSupplier({ ...fields, id: existing.id, active: existing.active, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
  return validateState({ ...current, suppliers: current.suppliers.map((supplier) => supplier.id === supplierId ? next : supplier) });
}

function deactivateSupplier(state, supplierId) {
  const current = validateState(state);
  const existing = current.suppliers.find((supplier) => supplier.id === supplierId);
  if (!existing) throw new Error('找不到供應商');
  return validateState({ ...current, suppliers: current.suppliers.map((supplier) => supplier.id === supplierId ? { ...supplier, active: false, updatedAt: new Date().toISOString() } : supplier) });
}

function purchaseCents(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+(\.\d{1,2})?$/.test(String(value).trim())) throw new Error('進貨金額須為非負數且最多兩位小數');
  const [whole, fraction = ''] = String(value).trim().split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error('進貨金額超出安全範圍');
  return result;
}

function purchaseQuantity(value) {
  const result = positiveInteger(value, '進貨數量');
  if (!Number.isSafeInteger(result)) throw new Error('進貨數量超出安全範圍');
  return result;
}

function purchaseAmount(cents) {
  const amount = cents / 100;
  if (!Number.isSafeInteger(cents) || purchaseCents(amount) !== cents) throw new Error('進貨金額超出可安全儲存的精度');
  return amount;
}

function normalizedPurchase(value, supplierIds, itemIds) {
  const supplierId = id(value?.supplierId, '供應商 ID');
  if (!supplierIds.has(supplierId)) throw new Error('進貨供應商不存在');
  if (!/^P\d{8}\d{3}$/.test(value?.number) || value.number.endsWith('000')) throw new Error('進貨單號無效');
  const day = value.number.slice(1, 9);
  calendarDate(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`, '進貨單號日期');
  if (!['draft', 'received'].includes(value?.status) || !['unpaid', 'paid'].includes(value?.paymentStatus)) throw new Error('進貨狀態無效');
  if (!Array.isArray(value?.lines) || !value.lines.length) throw new Error('進貨至少需要一筆明細');
  let totalCents = 0;
  const seen = new Set();
  const lines = value.lines.map((line) => {
    const itemId = id(line?.itemId, '品項 ID');
    if (!itemIds.has(itemId)) throw new Error('進貨品項不存在');
    if (seen.has(itemId)) throw new Error('進貨品項重複');
    seen.add(itemId);
    const quantity = purchaseQuantity(line.quantity);
    const unitCents = purchaseCents(line.unitCost);
    const subtotalCents = quantity * unitCents;
    totalCents += subtotalCents;
    if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalCents)) throw new Error('進貨金額超出安全範圍');
    if (purchaseCents(line.subtotal) !== subtotalCents) throw new Error('進貨小計無效');
    return { itemId, itemName: id(line.itemName, '進貨品項名稱'), sku: text(line.sku), barcode: text(line.barcode), quantity, unitCost: purchaseAmount(unitCents), subtotal: purchaseAmount(subtotalCents) };
  });
  if (purchaseCents(value.total) !== totalCents) throw new Error('進貨總額無效');
  const snapshot = value.supplierSnapshot;
  const supplierSnapshot = { name: id(snapshot?.name, '供應商快照名稱'), contact: text(snapshot?.contact), phone: text(snapshot?.phone), address: text(snapshot?.address), taxId: text(snapshot?.taxId) };
  if (supplierSnapshot.taxId && !/^\d{8}$/.test(supplierSnapshot.taxId)) throw new Error('供應商快照統編無效');
  const received = value.status === 'received';
  const paid = value.paymentStatus === 'paid';
  const receivedAt = received ? date(value.receivedAt, '收貨日期') : '';
  const paidAt = paid ? date(value.paidAt, '付款日期') : '';
  if ((!received && (paid || value.receivedAt || value.receivedBy || value.receivedByAccount)) || (!paid && (value.paidAt || value.paidBy || value.paidByAccount))) throw new Error('收貨或付款狀態與日期不一致');
  const createdAt = date(value.createdAt, '進貨建立日期');
  const updatedAt = date(value.updatedAt, '進貨更新日期');
  if (Date.parse(updatedAt) < Date.parse(createdAt) || (received && Date.parse(receivedAt) < Date.parse(createdAt)) || (paid && Date.parse(paidAt) < Date.parse(receivedAt))) throw new Error('進貨日期順序無效');
  return { id: id(value.id, '進貨 ID'), number: value.number, supplierId, supplierSnapshot, status: value.status, paymentStatus: value.paymentStatus, lines, total: purchaseAmount(totalCents), note: text(value.note), createdAt, updatedAt, receivedAt, paidAt, createdBy: text(value.createdBy), receivedBy: text(value.receivedBy), paidBy: text(value.paidBy), createdByAccount: text(value.createdByAccount), receivedByAccount: text(value.receivedByAccount), paidByAccount: text(value.paidByAccount) };
}

function purchaseFields(state, fields) {
  const supplier = state.suppliers.find((candidate) => candidate.id === fields.supplierId);
  if (!supplier) throw new Error('供應商不存在');
  if (!Array.isArray(fields.lines) || !fields.lines.length) throw new Error('進貨至少需要一筆明細');
  const lines = fields.lines.map((line) => {
    const item = state.items.find((candidate) => candidate.id === line.itemId);
    if (!item || item.supplierId !== supplier.id) throw new Error('品項不存在或不屬於此供應商，請修改草稿');
    const quantity = purchaseQuantity(line.quantity);
    const unitCents = purchaseCents(line.unitCost);
    const subtotal = quantity * unitCents;
    if (!Number.isSafeInteger(subtotal)) throw new Error('進貨金額超出安全範圍');
    return { itemId: item.id, itemName: item.name, sku: item.sku, barcode: item.barcode, quantity, unitCost: purchaseAmount(unitCents), subtotal: purchaseAmount(subtotal) };
  });
  const total = lines.reduce((sum, line) => sum + purchaseCents(line.subtotal), 0);
  if (!Number.isSafeInteger(total)) throw new Error('進貨金額超出安全範圍');
  const { name, contact, phone, address, taxId } = supplier;
  return { supplierId: supplier.id, supplierSnapshot: { name, contact, phone, address, taxId }, lines, total: purchaseAmount(total), note: text(fields.note) };
}

function createPurchase(state, fields) {
  const current = validateState(state);
  if (!current.suppliers.find((supplier) => supplier.id === fields.supplierId)?.active) throw new Error('供應商不存在或已停用');
  const timestamp = new Date().toISOString();
  const prefix = 'P' + taipeiDate(timestamp).replaceAll('-', '');
  const sequence = current.purchases.reduce((max, purchase) => purchase.number.startsWith(prefix) ? Math.max(max, Number(purchase.number.slice(-3))) : max, 0) + 1;
  if (sequence > 999) throw new Error('當日進貨單已達 999 筆');
  const purchase = { ...purchaseFields(current, fields), id: crypto.randomUUID(), number: prefix + String(sequence).padStart(3, '0'), status: 'draft', paymentStatus: 'unpaid', createdAt: timestamp, updatedAt: timestamp, receivedAt: '', paidAt: '', createdBy: text(fields.createdBy), receivedBy: '', paidBy: '' };
  purchase.createdByAccount = text(fields.createdByAccount);
  return validateState({ ...current, purchases: [...current.purchases, purchase] });
}

function updatePurchase(state, purchaseId, fields) {
  const current = validateState(state);
  const existing = current.purchases.find((purchase) => purchase.id === purchaseId);
  if (!existing || existing.status !== 'draft') throw new Error('找不到草稿或進貨單已收貨，無法修改');
  if (fields.supplierId !== existing.supplierId && !current.suppliers.find((supplier) => supplier.id === fields.supplierId)?.active) throw new Error('不能改為已停用供應商');
  const next = { ...existing, ...purchaseFields(current, fields), updatedAt: new Date().toISOString() };
  return validateState({ ...current, purchases: current.purchases.map((purchase) => purchase.id === purchaseId ? next : purchase) });
}

function deletePurchase(state, purchaseId) {
  const current = validateState(state);
  const existing = current.purchases.find((purchase) => purchase.id === purchaseId);
  if (!existing || existing.status !== 'draft') throw new Error('找不到草稿或進貨單已收貨，無法刪除');
  return validateState({ ...current, purchases: current.purchases.filter((purchase) => purchase.id !== purchaseId) });
}

function receivePurchase(state, purchaseId, { receivedBy, receivedByAccount, serialNumbersByItem = {} } = {}) {
  const current = validateState(state);
  const existing = current.purchases.find((purchase) => purchase.id === purchaseId);
  if (!existing || existing.status !== 'draft') throw new Error('找不到草稿或進貨單已收貨');
  purchaseFields(current, existing);
  if (!serialNumbersByItem || typeof serialNumbersByItem !== 'object' || Array.isArray(serialNumbersByItem)) throw new Error('收貨序號格式無效');
  if (Object.keys(serialNumbersByItem).some(itemId => !existing.lines.some(line => line.itemId === itemId))) throw new Error('收貨序號品項不在進貨單');
  const serials = [...current.serials];
  for (const line of existing.lines) {
    const item = current.items.find(item => item.id === line.itemId);
    const added = newSerials({ ...current, serials }, item, serialNumbersByItem[line.itemId], receivedBy, purchaseId);
    if (requiresSerial(item)) {
      serialStock(item.stock); serialStock(line.quantity);
      if (added.length !== line.quantity) throw new Error(`收貨序號數量不符：${item.name}`);
    }
    serials.push(...added);
  }
  const timestamp = new Date().toISOString();
  const items = current.items.map((item) => {
    const line = existing.lines.find((entry) => entry.itemId === item.id);
    if (!line) return item;
    const stock = item.stock + line.quantity;
    if (!Number.isFinite(stock) || stock > Number.MAX_SAFE_INTEGER) throw new Error('收貨後庫存超出安全範圍');
    return { ...item, stock, cost: line.unitCost };
  });
  const transactions = existing.lines.map((line) => ({ id: crypto.randomUUID(), itemId: line.itemId, type: 'in', quantity: line.quantity, createdAt: timestamp, note: `進貨收貨：${existing.number}`, purchaseId }));
  const received = { ...existing, status: 'received', receivedAt: timestamp, receivedBy: text(receivedBy), receivedByAccount: text(receivedByAccount), updatedAt: timestamp };
  return validateState({ ...current, items, serials, transactions: [...current.transactions, ...transactions], purchases: current.purchases.map((purchase) => purchase.id === purchaseId ? received : purchase) });
}

function markPurchasePaid(state, purchaseId, { paidBy, paidByAccount } = {}) {
  const current = validateState(state);
  const existing = current.purchases.find((purchase) => purchase.id === purchaseId);
  if (!existing || existing.status !== 'received') throw new Error('進貨單尚未收貨，無法標記付款');
  if (existing.paymentStatus === 'paid') throw new Error('進貨單已付款');
  const timestamp = new Date().toISOString();
  const paid = { ...existing, paymentStatus: 'paid', paidAt: timestamp, paidBy: text(paidBy), paidByAccount: text(paidByAccount), updatedAt: timestamp };
  return validateState({ ...current, purchases: current.purchases.map((purchase) => purchase.id === purchaseId ? paid : purchase) });
}

function batteryItemName(item) {
  if (item.category !== '電池') return item.name;
  const base = item.name.replace(/\s*\d{1,2}\s*V\s*\d{1,2}\s*Ah$/i, '').trim();
  return `${base} ${item.voltage}V ${item.capacity}Ah`.trim();
}

function validateBatterySpecs(item) {
  if (item.category !== '電池') return;
  if (!Number.isInteger(item.voltage) || item.voltage < 1 || item.voltage > 99) throw new Error('電池電壓須為 1～99 的整數。');
  if (!Number.isInteger(item.capacity) || item.capacity < 1 || item.capacity > 99) throw new Error('電池容量須為 1～99 的整數。');
}

function deleteItem(state, itemId) {
  const current = validateState(state);
  if (current.transactions.some(t => t.type === 'warranty_out' && t.itemId === itemId)) throw new Error('品項已有出保固紀錄，無法刪除');
  if (current.serials.some(s => s.itemId === itemId)) throw new Error('品項已有序號紀錄，無法刪除');
  if (current.purchases.some((purchase) => purchase.lines.some((line) => line.itemId === itemId))) throw new Error('品項已有進貨紀錄，無法刪除');
  if (!current.items.some((item) => item.id === itemId)) throw new Error('找不到品項');
  if (current.quotations.some((quotation) => quotation.lines.some((line) => line.itemId === itemId))) throw new Error('品項已有報價紀錄，無法刪除');
  return validateState({
    ...current,
    items: current.items.filter((item) => item.id !== itemId),
    transactions: current.transactions.filter((transaction) => transaction.itemId !== itemId),
  });
}

function recordTransaction(state, fields) {
  const current = validateState(state);
  const itemId = id(fields?.itemId, '品項 ID');
  const type = fields?.type;
  if (!transactionTypes.has(type)) throw new Error('異動類型無效');
  const quantity = number(fields?.quantity, '異動數量');
  const item = current.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error('找不到品項');
  const warranty = type === 'warranty_out' ? current.warranties.find(w => w.id === fields.warrantyId) : null;
  if (type === 'warranty_out') {
    if (!warranty) throw new Error('請選擇原保固紀錄');
    positiveInteger(quantity, '出保固數量'); serialStock(quantity); id(fields.createdBy, '操作帳號'); id(fields.note, '出保固原因');
  }
  const stock = type === 'in' ? item.stock + quantity : type === 'out' || type === 'warranty_out' ? item.stock - quantity : quantity;
  if (stock < 0) throw new Error('庫存不足，無法售出');
  const timestamp = new Date().toISOString();
  let issuedSerials = [];
  let serials = current.serials;
  if (requiresSerial(item)) {
    serialStock(stock); serialStock(quantity);
    const selected = selectedSerials(current, item, fields.serialIds);
    const delta = stock - item.stock;
    const fractional = !Number.isSafeInteger(item.stock);
    if (fractional && type !== 'adjust') throw new Error('請先盤點更正庫存');
    const added = newSerials(current, item, fields.serialNumbers, fields.createdBy);
    const expectedNew = fractional ? 0 : Math.max(0, delta);
    if (added.length !== expectedNew) throw new Error('入庫數量與新增序號數不符');
    if (type === 'out' || type === 'warranty_out') {
      requireCompleteSerials(current, item);
      if (selected.length !== quantity) throw new Error('移出數量與序號數不符');
    } else if ((delta >= 0 && selected.length) || (delta < 0 && selected.length > Math.ceil(-delta))) throw new Error('移出序號數量不符');
    if (selected.length) { id(fields.createdBy, '移出操作者'); id(fields.note, '移出原因'); }
    issuedSerials = selected;
    serials = [...current.serials.map(s => selected.some(chosen => chosen.id === s.id) ? { ...s, status: warranty ? 'warranty_out' : 'removed', ...(warranty ? { warrantyId: warranty.id, customerId: warranty.customerId } : {}), removedAt: timestamp, removedBy: text(fields.createdBy), removalReason: text(fields.note) } : s), ...added];
  } else if ((fields.serialIds?.length ?? 0) || (fields.serialNumbers?.length ?? 0)) throw new Error('此品項不使用序號管理');
  const transaction = {
    id: crypto.randomUUID(),
    itemId,
    type,
    quantity,
    createdAt: timestamp,
    note: text(fields.note),
  };
  if (warranty) Object.assign(transaction, { warrantyId: warranty.id, customerId: warranty.customerId, customerName: warranty.customerName,
    itemName: item.name, expiresAt: warranty.expiresAt, unitCostSnapshot: item.cost, createdBy: text(fields.createdBy), createdByAccount: text(fields.createdByAccount) || text(fields.createdBy),
    serialIds: issuedSerials.map(s => s.id), serialNumbers: issuedSerials.map(s => s.serialNumber) });
  return validateState({
    ...current,
    serials,
    items: current.items.map((candidate) => candidate.id === itemId ? { ...candidate, stock } : candidate),
    transactions: [...current.transactions, transaction],
  });
}

function addCustomer(state, fields) {
  const current = validateState(state);
  const timestamp = new Date().toISOString();
  const nextNumber = current.customers.reduce((largest, customer) => Math.max(largest, Number(customer.memberNumber.slice(1)) || 0), 0) + 1;
  const customer = normalizedCustomer({ ...fields, id: crypto.randomUUID(), memberNumber: `M${String(nextNumber).padStart(6, '0')}`, active: true, createdAt: timestamp, updatedAt: timestamp });
  return validateState({ ...current, customers: [...current.customers, customer] });
}

function updateCustomer(state, customerId, fields) {
  const current = validateState(state);
  const existing = current.customers.find((customer) => customer.id === customerId);
  if (!existing) throw new Error('找不到客戶');
  const customer = normalizedCustomer({ ...fields, id: existing.id, memberNumber: existing.memberNumber, active: existing.active, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
  return validateState({ ...current, customers: current.customers.map((candidate) => candidate.id === customerId ? customer : candidate) });
}

function deactivateCustomer(state, customerId) {
  const current = validateState(state);
  const customer = current.customers.find((candidate) => candidate.id === customerId);
  if (!customer) throw new Error('找不到客戶');
  return validateState({ ...current, customers: current.customers.map((candidate) => candidate.id === customerId ? { ...customer, active: false, updatedAt: new Date().toISOString() } : candidate) });
}

function deleteCustomer(state, customerId) {
  const current = validateState(state);
  if (current.transactions.some(t => t.type === 'warranty_out' && t.customerId === customerId)) throw new Error('客戶已有出保固紀錄，無法刪除');
  if (!current.customers.some((customer) => customer.id === customerId)) throw new Error('找不到客戶');
  if (current.quotations.some((quotation) => quotation.customerId === customerId)) throw new Error('客戶已有報價紀錄，無法刪除');
  return validateState({ ...current, customers: current.customers.filter((customer) => customer.id !== customerId) });
}

function addSalesperson(state, fields) {
  const current = validateState(state);
  const timestamp = new Date().toISOString();
  const salesperson = normalizedSalesperson({ ...fields, id: crypto.randomUUID(), active: true, createdAt: timestamp, updatedAt: timestamp });
  return validateState({ ...current, salespeople: [...current.salespeople, salesperson] });
}

function updateSalesperson(state, salespersonId, fields) {
  const current = validateState(state);
  const existing = current.salespeople.find((salesperson) => salesperson.id === salespersonId);
  if (!existing) throw new Error('找不到業務');
  const salesperson = normalizedSalesperson({ ...existing, ...fields, id: existing.id, active: existing.active, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
  return validateState({ ...current, salespeople: current.salespeople.map((candidate) => candidate.id === salespersonId ? salesperson : candidate) });
}

function deactivateSalesperson(state, salespersonId) {
  const current = validateState(state);
  const salesperson = current.salespeople.find((candidate) => candidate.id === salespersonId);
  if (!salesperson) throw new Error('找不到業務');
  return validateState({ ...current, salespeople: current.salespeople.map((candidate) => candidate.id === salespersonId ? { ...salesperson, active: false, updatedAt: new Date().toISOString() } : candidate) });
}

function createQuotation(state, fields) {
  const current = validateState(state);
  const customer = current.customers.find((candidate) => candidate.id === fields?.customerId);
  if (!customer) throw new Error('找不到客戶');
  if (!customer.active) throw new Error('客戶已停用，無法建立報價');
  const salesperson = current.salespeople.find((candidate) => candidate.id === fields?.salespersonId);
  if (!salesperson) throw new Error('找不到業務');
  if (!salesperson.active) throw new Error('業務已停用，無法建立報價');
  if (!Array.isArray(fields?.lines) || !fields.lines.length) throw new Error('報價至少需要一筆明細');
  const lines = fields.lines.map((line) => {
    const item = current.items.find((candidate) => candidate.id === line?.itemId);
    if (!item) throw new Error('找不到品項');
    const quantity = positiveInteger(line?.quantity, '報價數量');
    return { itemId: item.id, itemName: item.name, quantity, unitPrice: item.price, subtotal: quantity * item.price };
  });
  const timestamp = new Date().toISOString();
  const datePrefix = timestamp.slice(0, 10).replaceAll('-', '');
  const sequence = current.quotations.reduce((largest, quotation) => {
    if (!quotation.number.startsWith(`${datePrefix}-`)) return largest;
    return Math.max(largest, Number(quotation.number.slice(datePrefix.length + 1)) || 0);
  }, 0) + 1;
  const quotation = {
    id: crypto.randomUUID(),
    number: `${datePrefix}-${String(sequence).padStart(3, '0')}`,
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    salespersonId: salesperson.id,
    salespersonName: salesperson.name,
    lines,
    total: lines.reduce((sum, line) => sum + line.subtotal, 0),
    note: text(fields.note),
    createdAt: timestamp,
  };
  return validateState({ ...current, quotations: [...current.quotations, quotation] });
}

function toBackup(state) {
  return JSON.stringify(validateState(state), null, 2);
}

function createWarranty(state, fields) {
  const current = validateState(state);
  const customer = current.customers.find((candidate) => candidate.id === fields?.customerId);
  if (!customer) throw new Error('找不到客戶');
  const item = current.items.find((candidate) => candidate.id === fields?.itemId);
  if (!item) throw new Error('找不到品項');
  const warranty = normalizedWarranty({
    id: crypto.randomUUID(), customerId: customer.id, customerName: customer.name,
    itemId: item.id, itemName: item.name, barcode: item.barcode, source: 'manual',
    purchasedAt: fields?.purchasedAt, expiresAt: fields?.expiresAt, note: fields?.note,
    createdBy: fields?.createdBy, createdAt: new Date().toISOString(),
  });
  if (requiresSerial(item)) {
    const serial = current.serials.find(s => s.id === fields.serialId && s.itemId === item.id && s.customerId === customer.id && s.status === 'sold');
    if (!serial) throw new Error('請選擇此客戶已購買的商品序號');
    const sale = current.sales.find(sale => sale.id === serial.saleId);
    Object.assign(warranty, { serialId: serial.id, serialNumber: serial.serialNumber, saleId: sale.id, saleNumber: sale.saleNumber || '' });
  } else if (fields?.serialId) throw new Error('此品項不使用序號管理');
  return validateState({ ...current, warranties: [...current.warranties, warranty] });
}

function updateWarranty(state, warrantyId, fields) {
  const current = validateState(state);
  const existing = current.warranties.find((warranty) => warranty.id === warrantyId);
  if (!existing) throw new Error('找不到保固');
  const warranty = normalizedWarranty({ ...existing, ...fields, id: existing.id, source: existing.source, itemId: existing.itemId, itemName: existing.itemName, barcode: existing.barcode, customerId: existing.customerId, customerName: existing.customerName, serialId: existing.serialId, serialNumber: existing.serialNumber, saleId: existing.saleId, saleNumber: existing.saleNumber, createdAt: existing.createdAt });
  return validateState({ ...current, warranties: current.warranties.map((candidate) => candidate.id === warrantyId ? warranty : candidate) });
}

function deleteWarranty(state, warrantyId) {
  const current = validateState(state);
  if (current.transactions.some(t => t.type === 'warranty_out' && t.warrantyId === warrantyId)) throw new Error('已有出保固紀錄，不可刪除原保固。');
  if (!current.warranties.some((warranty) => warranty.id === warrantyId)) throw new Error('找不到保固');
  return validateState({ ...current, warranties: current.warranties.filter((warranty) => warranty.id !== warrantyId), warrantyCases: current.warrantyCases.filter((warrantyCase) => warrantyCase.warrantyId !== warrantyId) });
}

function addWarrantyCase(state, fields) {
  const current = validateState(state);
  const warranty = current.warranties.find((candidate) => candidate.id === fields?.warrantyId);
  if (!warranty) throw new Error('找不到保固');
  const timestamp = new Date().toISOString();
  const warrantyCase = normalizedWarrantyCase({
    id: crypto.randomUUID(), warrantyId: warranty.id, issue: fields?.issue,
    status: fields?.status ?? 'pending', handledAt: fields?.handledAt,
    resolutionNote: fields?.resolutionNote, itemName: warranty.itemName,
    purchasedAt: warranty.purchasedAt, expiresAt: warranty.expiresAt,
    createdBy: fields?.createdBy, createdAt: timestamp, updatedAt: timestamp,
  }, new Set([warranty.id]));
  return validateState({ ...current, warrantyCases: [...current.warrantyCases, warrantyCase] });
}

function updateWarrantyCase(state, caseId, fields) {
  const current = validateState(state);
  const existing = current.warrantyCases.find((warrantyCase) => warrantyCase.id === caseId);
  if (!existing) throw new Error('找不到案件');
  const warrantyCase = normalizedWarrantyCase({ ...existing, ...fields, id: existing.id, warrantyId: existing.warrantyId, itemName: existing.itemName, purchasedAt: existing.purchasedAt, expiresAt: existing.expiresAt, createdAt: existing.createdAt, updatedAt: new Date().toISOString() }, new Set(current.warranties.map((warranty) => warranty.id)));
  return validateState({ ...current, warrantyCases: current.warrantyCases.map((candidate) => candidate.id === caseId ? warrantyCase : candidate) });
}

function deleteWarrantyCase(state, caseId) {
  const current = validateState(state);
  if (!current.warrantyCases.some((warrantyCase) => warrantyCase.id === caseId)) throw new Error('找不到案件');
  return validateState({ ...current, warrantyCases: current.warrantyCases.filter((warrantyCase) => warrantyCase.id !== caseId) });
}

function warrantiesForFilter(state, filter = {}) {
  const current = validateState(state);
  const query = text(filter.query).toLocaleLowerCase();
  const today = filter.today ? calendarDate(filter.today, '查詢日期') : taipeiDate(new Date());
  const soon = addMonths(today, 1);
  return current.warranties.filter((warranty) => {
    const replacements = current.transactions.filter(t => t.type === 'warranty_out' && t.warrantyId === warranty.id);
    if (query && ![warranty.customerName, warranty.itemName, warranty.barcode, warranty.serialNumber, ...replacements.flatMap(t => [t.itemName, ...t.serialNumbers])].some((value) => value.toLocaleLowerCase().includes(query))) return false;
    if (filter.status === 'active') return warranty.expiresAt >= today;
    if (filter.status === 'expiring') return warranty.expiresAt >= today && warranty.expiresAt <= soon;
    if (filter.status === 'expired') return warranty.expiresAt < today;
    if (filter.status === 'in_progress') return current.warrantyCases.some((warrantyCase) => warrantyCase.warrantyId === warranty.id && warrantyCase.status === 'in_progress');
    return true;
  });
}

function recordSale(state, fields) {
  const current = validateState(state);
  const barcode = text(fields?.barcode);
  const item = current.items.find((candidate) => candidate.barcode === barcode);
  if (!item) throw new Error('找不到此條碼的品項');
  if (requiresSerial(item)) return recordSaleBatch(state, { ...fields, lines: [{ itemId: item.id, quantity: fields.quantity, serialIds: fields.serialIds }] });
  const quantity = positiveInteger(fields?.quantity, '銷售數量');
  if (item.stock < quantity) throw new Error('庫存不足，無法售出');
  const salesperson = current.salespeople.find(candidate => candidate.id === text(fields?.salespersonId));
  if (!salesperson) throw new Error('請選擇業務員');
  if (!salesperson.active) throw new Error('業務員已停用，請重新選擇');
  const createdAt = new Date().toISOString();
  const sale = { id: crypto.randomUUID(), itemId: item.id, itemName: item.name, barcode: item.barcode, quantity, unitPrice: item.price, subtotal: item.price * quantity, createdAt, createdBy: text(fields?.createdBy), createdByAccount: text(fields?.createdByAccount), salespersonId: salesperson.id, serialIds: [], serialNumbers: [] };
  const transaction = { id: crypto.randomUUID(), itemId: item.id, type: 'out', quantity, createdAt, note: '銷售管理' };
  return { ...current, items: current.items.map((candidate) => candidate.id === item.id ? { ...candidate, stock: candidate.stock - quantity } : candidate), transactions: [...current.transactions, transaction], sales: [...current.sales, sale] };
}

function recordSaleBatch(state, fields) {
  const current = validateState(state);
  if (!Array.isArray(fields?.lines) || !fields.lines.length) throw new Error('購物車至少需要一筆商品');
  const requested = fields.lines.map((line) => {
    const itemId = text(line?.itemId), barcode = text(line?.barcode);
    const item = current.items.find((candidate) => itemId ? candidate.id === itemId : barcode && candidate.barcode === barcode);
    if (!item) throw new Error('找不到此品項');
    const quantity = positiveInteger(line?.quantity, '銷售數量');
    const serials = selectedSerials(current, item, line?.serialIds);
    if (requiresSerial(item)) {
      requireCompleteSerials(current, item);
      if (serials.length !== quantity) throw new Error('銷售數量與所選序號數量不符');
    }
    return { item, quantity, serials };
  });
  const quantities = new Map();
  requested.forEach((line) => quantities.set(line.item.id, (quantities.get(line.item.id) ?? 0) + line.quantity));
  const items = requested.map((line) => line.item);
  quantities.forEach((quantity, id) => { const item = current.items.find((candidate) => candidate.id === id); if (item.stock < quantity) throw new Error(`庫存不足：${item.name}`); });
  const customer = fields.customerId ? current.customers.find((candidate) => candidate.id === fields.customerId) : null;
  if (fields.customerId && !customer) throw new Error('找不到客戶');
  if (items.some(requiresSerial) && !customer) throw new Error('序號商品結帳必須選擇客戶');
  const serialIds = requested.flatMap(line => line.serials.map(s => s.id));
  if (new Set(serialIds).size !== serialIds.length) throw new Error('購物車序號重複');
  const salesperson = current.salespeople.find(candidate => candidate.id === text(fields?.salespersonId));
  if (!salesperson) throw new Error('請選擇業務員');
  if (!salesperson.active) throw new Error('業務員已停用，請重新選擇');
  const createdAt = new Date().toISOString();
  const saleNumber = `S${createdAt.slice(0, 10).replaceAll('-', '')}-${String(current.sales.length + 1).padStart(4, '0')}`;
  const purchasedAt = taipeiDate(createdAt);
  const sales = requested.map((line) => { const item = line.item; return { id: crypto.randomUUID(), saleNumber, customerId: customer?.id ?? '', itemId: item.id, itemName: item.name, barcode: item.barcode, quantity: line.quantity, unitPrice: item.price, subtotal: item.price * line.quantity, createdAt, createdBy: text(fields?.createdBy), createdByAccount: text(fields?.createdByAccount), salespersonId: salesperson.id, serialIds: line.serials.map(s => s.id), serialNumbers: line.serials.map(s => s.serialNumber) }; });
  const serials = current.serials.map(serial => {
    const sale = sales.find(sale => sale.serialIds.includes(serial.id));
    return sale ? { ...serial, status: 'sold', saleId: sale.id, customerId: customer.id, soldAt: createdAt } : serial;
  });
  const transactions = sales.map((sale) => ({ id: crypto.randomUUID(), itemId: sale.itemId, type: 'out', quantity: sale.quantity, createdAt, note: `銷售管理 ${saleNumber}` }));
  const warranties = customer ? sales.flatMap((sale) => {
    const item = items.find((candidate) => candidate.id === sale.itemId);
    if (!item.warrantyMonths) return [];
    const units = sale.serialIds.length ? sale.serialIds.map((serialId, index) => ({ serialId, serialNumber: sale.serialNumbers[index] })) : [{}];
    return units.map(unit => normalizedWarranty({ id: crypto.randomUUID(), customerId: customer.id, customerName: customer.name, itemId: item.id, itemName: sale.itemName, barcode: sale.barcode, source: 'sale', saleId: sale.id, saleNumber, purchasedAt, expiresAt: addMonths(purchasedAt, item.warrantyMonths), createdBy: fields.createdBy, createdAt, ...unit }));
  }) : [];
  return validateState({ ...current, serials, items: current.items.map((item) => ({ ...item, stock: item.stock - (quantities.get(item.id) ?? 0) })), transactions: [...current.transactions, ...transactions], sales: [...current.sales, ...sales], warranties: [...current.warranties, ...warranties] });
}

function salesForMonth(state, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const [year, numericMonth] = month.split('-').map(Number);
  const start = Date.UTC(year, numericMonth - 1, 1) - 8 * 60 * 60 * 1000;
  const end = Date.UTC(year, numericMonth, 1) - 8 * 60 * 60 * 1000;
  return validateState(state).sales.filter((sale) => {
    const at = Date.parse(sale.createdAt);
    return at >= start && at < end;
  });
}

window.Inventory = { requiresSerial, registerSerials, receivePurchase, markPurchasePaid, createPurchase, updatePurchase, deletePurchase, addSupplier, updateSupplier, deactivateSupplier, addCustomer, addItem, addSalesperson, addWarrantyCase, createQuotation, createWarranty, deactivateCustomer, deactivateSalesperson, deleteCustomer, deleteItem, deleteWarranty, deleteWarrantyCase, code128Modules, emptyState, inventoryCost, recordSale, recordSaleBatch, recordTransaction, salesForMonth, toBackup, updateCustomer, updateItem, updateSalesperson, updateWarranty, updateWarrantyCase, validateState, warrantiesForFilter };
