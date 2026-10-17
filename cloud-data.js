(() => {
  const empty = () => window.Inventory.emptyState();

  function transactionType(type, warrantyId) {
    return warrantyId ? 'warranty_out' : type === 'set' ? 'adjust' : type;
  }

  function snapshotFromRows({ items, costs, transactions, customers, salespeople, sales, saleLines, suppliers, quotations, quotationLines, purchases, purchaseLines, serials, warranties, warrantyCases, admin }) {
    const costByItem = new Map(costs.map(row => [row.item_id, Number(row.cost)]));
    const itemById = new Map(items.map(row => [row.id, row]));
    const customerById = new Map(customers.map(row => [row.id, row]));
    const salespersonById = new Map(salespeople.map(row => [row.id, row]));
    const linesBySale = new Map();
    const linesByQuotation = new Map();
    const linesByPurchase = new Map();
    const serialsBySaleLine = new Map();
    quotationLines.forEach(line => linesByQuotation.set(line.quotation_id, [...(linesByQuotation.get(line.quotation_id) ?? []), line]));
    purchaseLines.forEach(line => linesByPurchase.set(line.purchase_id, [...(linesByPurchase.get(line.purchase_id) ?? []), line]));
    serials.forEach(serial => { if (serial.sale_line_id) serialsBySaleLine.set(serial.sale_line_id, [...(serialsBySaleLine.get(serial.sale_line_id) ?? []), serial]); });
    saleLines.forEach(line => linesBySale.set(line.sale_id, [...(linesBySale.get(line.sale_id) ?? []), line]));
    return window.Inventory.validateState({
      ...empty(),
      items: items.map(row => ({ id: row.id, name: row.name, category: row.category, sku: row.sku, barcode: row.barcode, cost: costByItem.get(row.id) ?? 0, price: Number(row.price), stock: Number(row.stock), minimumStock: Number(row.minimum_stock), warrantyMonths: Number(row.warranty_months ?? 0), notes: row.notes, supplierId: admin ? row.supplier_id ?? '' : '' })),
      transactions: transactions.map(row => ({ id: row.id, itemId: row.item_id, type: transactionType(row.type, row.warranty_id), quantity: Number(row.quantity), note: row.note, purchaseId: admin ? row.purchase_id ?? '' : '', repairOrderId: row.repair_order_id ?? '', warrantyId: row.warranty_id ?? '', customerId: row.customer_id ?? '', customerName: customerById.get(row.customer_id)?.name ?? '', itemName: row.item_name ?? '', expiresAt: row.expires_at ?? '', unitCostSnapshot: row.unit_cost_snapshot == null ? undefined : Number(row.unit_cost_snapshot), createdBy: row.created_by ?? '', createdByAccount: '', serialIds: row.serial_ids ?? [], serialNumbers: row.serial_numbers ?? [], createdAt: row.created_at })),
      customers: customers.map(row => ({ id: row.id, memberNumber: row.member_number, name: row.name, phone: row.phone, plateNumbers: row.plate_numbers ?? [], address: row.address, note: row.note, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })),
      salespeople: salespeople.map(row => ({ id: row.id, name: row.name, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })),
      suppliers: suppliers.map(row => ({ id: row.id, name: row.name, contact: row.contact, phone: row.phone, address: row.address, taxId: row.tax_id, note: row.note, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })),
      purchases: purchases.map(row => ({ id: row.id, number: row.purchase_number, supplierId: row.supplier_id, supplierSnapshot: row.supplier_snapshot, status: row.status, paymentStatus: row.payment_status, lines: (linesByPurchase.get(row.id) ?? []).map(line => ({ itemId: line.item_id, itemName: line.item_name, sku: line.item_sku, barcode: line.item_barcode, quantity: Number(line.quantity), unitCost: Number(line.unit_cost), subtotal: Number(line.subtotal) })), total: Number(row.total), note: row.note, createdAt: row.created_at, updatedAt: row.updated_at, receivedAt: row.received_at ?? '', paidAt: row.paid_at ?? '', createdBy: row.created_by, receivedBy: row.received_by ?? '', paidBy: row.paid_by ?? '', createdByAccount: '', receivedByAccount: '', paidByAccount: '' })),
      serials: serials.map(row => ({ id: row.id, itemId: row.item_id, serialNumber: row.serial_number, status: row.status, purchaseId: admin ? row.purchase_id ?? '' : '', saleId: row.sale_line_id ?? '', customerId: row.customer_id ?? '', warrantyId: row.warranty_id ?? '', repairOrderId: row.repair_order_id ?? '', repairLineId: row.repair_line_id ?? '', repairUsedAt: row.repair_used_at ?? '', createdBy: row.created_by, createdAt: row.created_at, soldAt: row.sold_at ?? '', removedAt: row.removed_at ?? '', removedBy: row.removed_by ?? '', removalReason: row.removal_reason ?? '' })),
      quotations: quotations.map(row => ({ id: row.id, number: row.quote_number, customerId: row.customer_id, customerName: customerById.get(row.customer_id)?.name ?? '', customerPhone: customerById.get(row.customer_id)?.phone ?? '', salespersonId: row.salesperson_id ?? '', salespersonName: row.salesperson_id ? salespersonById.get(row.salesperson_id)?.name ?? '' : '', lines: (linesByQuotation.get(row.id) ?? []).map(line => ({ itemId: line.item_id, itemName: line.item_name, quantity: Number(line.quantity), unitPrice: Number(line.unit_price), subtotal: Number(line.subtotal), installationRequired: line.installation_required ?? false, laborHours: Number(line.labor_hours ?? 0), hourlyRate: Number(line.hourly_rate ?? 0), laborAmount: Number(line.labor_amount ?? 0) })), total: Number(row.total), note: row.note, createdAt: row.created_at })),
      sales: sales.flatMap(sale => (linesBySale.get(sale.id) ?? []).map(line => ({ id: line.id, checkoutId: sale.id, saleNumber: sale.sale_number, customerId: sale.customer_id ?? '', itemId: line.item_id, itemName: line.item_name, barcode: line.barcode, quantity: Number(line.quantity), unitPrice: Number(line.unit_price), subtotal: Number(line.subtotal), createdAt: sale.created_at, createdBy: sale.created_by, createdByAccount: '', serialIds: (serialsBySaleLine.get(line.id) ?? []).map(serial => serial.id), serialNumbers: (serialsBySaleLine.get(line.id) ?? []).map(serial => serial.serial_number) }))),
      warranties: warranties.map(row => ({ id: row.id, customerId: row.customer_id, customerName: row.customer_name, itemId: row.item_id, itemName: row.item_name, barcode: row.barcode, source: row.source, saleId: row.sale_line_id ?? '', saleNumber: row.sale_number, repairOrderId: row.repair_order_id ?? '', serialId: row.serial_id ?? '', serialNumber: row.serial_number ?? '', purchasedAt: row.purchased_at, expiresAt: row.expires_at, note: row.note, createdBy: row.created_by, createdAt: row.created_at })),
      warrantyCases: warrantyCases.map(row => ({ id: row.id, warrantyId: row.warranty_id, issue: row.issue, status: row.status, handledAt: row.handled_at ?? '', resolutionNote: row.resolution_note, itemName: row.item_name, purchasedAt: row.purchased_at, expiresAt: row.expires_at, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at })),
    });
  }

  // Supabase 每次查詢預設最多回 1000 列；超過時要分頁抓完，否則畫面會悄悄少資料。
  const PAGE_SIZE = 1000;
  const keyColumn = table => table === 'item_costs' ? 'item_id' : 'id';
  async function query(client, table, fields) {
    const key = keyColumn(table);
    const rows = new Map();
    for (let from = 0; ; from += PAGE_SIZE) {
      const request = client.from(table).select(fields);
      // 測試替身沒有 order/range 時，維持單次查詢。
      if (typeof request?.order !== 'function') {
        const { data, error } = await request;
        if (error) throw error;
        return data ?? [];
      }
      // 依主鍵排序，分頁才不會漏抓或重複；同一列跨頁出現時以主鍵去重。
      const { data, error } = await request.order(key).range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      const page = data ?? [];
      page.forEach((row, index) => rows.set(row[key] ?? `${from + index}`, row));
      if (page.length < PAGE_SIZE) return [...rows.values()];
    }
  }

  // 只有「同一個登入帳號」寫入的快取，才能在雲端讀取失敗時拿來唯讀顯示。
  async function sessionUserId() {
    try {
      const { data } = await window.AppAuth.client.auth.getSession();
      return data?.session?.user?.id ?? '';
    } catch { return ''; }
  }

  // 雲端快照的每張表；key 對應 snapshotFromRows 的參數名稱。
  const SNAPSHOT_TABLES = [
    { key: 'items', table: 'items', fields: 'id,name,category,sku,barcode,price,stock,minimum_stock,warranty_months,notes,supplier_id', adminOnly: false },
    { key: 'costs', table: 'item_costs', fields: 'item_id,cost', adminOnly: true },
    { key: 'transactions', table: 'inventory_transactions', fields: 'id,item_id,type,quantity,note,purchase_id,repair_order_id,warranty_id,customer_id,item_name,expires_at,unit_cost_snapshot,serial_ids,serial_numbers,created_by,created_at', adminOnly: false },
    { key: 'customers', table: 'customers', fields: 'id,member_number,name,phone,plate_numbers,address,note,active,created_at,updated_at', adminOnly: false },
    { key: 'salespeople', table: 'salespeople', fields: 'id,name,active,created_at,updated_at', adminOnly: false },
    { key: 'sales', table: 'sales', fields: 'id,sale_number,customer_id,created_by,created_at', adminOnly: false },
    { key: 'saleLines', table: 'sale_lines', fields: 'id,sale_id,item_id,item_name,barcode,quantity,unit_price,subtotal', adminOnly: false },
    { key: 'suppliers', table: 'suppliers', fields: 'id,name,contact,phone,address,tax_id,note,active,created_at,updated_at', adminOnly: true },
    { key: 'quotations', table: 'quotations', fields: 'id,quote_number,customer_id,salesperson_id,total,note,created_at', adminOnly: false },
    { key: 'quotationLines', table: 'quotation_lines', fields: 'quotation_id,item_id,item_name,quantity,unit_price,subtotal,installation_required,labor_hours,hourly_rate,labor_amount', adminOnly: false },
    { key: 'purchases', table: 'purchases', fields: 'id,purchase_number,supplier_id,supplier_snapshot,status,payment_status,total,note,created_by,received_by,paid_by,created_at,updated_at,received_at,paid_at', adminOnly: true },
    { key: 'purchaseLines', table: 'purchase_lines', fields: 'purchase_id,item_id,item_name,item_sku,item_barcode,quantity,unit_cost,subtotal', adminOnly: true },
    { key: 'serials', table: 'inventory_serials', fields: 'id,item_id,serial_number,status,purchase_id,sale_line_id,customer_id,warranty_id,repair_order_id,repair_line_id,repair_used_at,created_by,created_at,sold_at,removed_at,removed_by,removal_reason', adminOnly: false },
    { key: 'warranties', table: 'warranties', fields: 'id,customer_id,customer_name,item_id,item_name,barcode,source,sale_line_id,sale_number,repair_order_id,serial_id,serial_number,purchased_at,expires_at,note,created_by,created_at', adminOnly: false },
    { key: 'warrantyCases', table: 'warranty_cases', fields: 'id,warranty_id,issue,status,handled_at,resolution_note,item_name,purchased_at,expires_at,created_by,created_at,updated_at', adminOnly: false },
    { key: 'shopSettings', table: 'shop_settings', fields: 'id,hourly_rate', adminOnly: false },
  ];
  // 上次完整讀取的原始資料。儲存後只重抓有變動的表，其餘沿用這份（超過 2 分鐘就整份重抓）。
  const PARTIAL_RELOAD_MAX_AGE_MS = 2 * 60 * 1000;
  let lastRows = null;

  // options.tables：只重抓這些表（Set of key）；其餘沿用上次讀取的資料。
  async function loadSnapshot(validatedUser, options = {}) {
    const cache = await window.InventoryStorage.loadState();
    let user = validatedUser;
    try {
      user = user ?? await window.AppAuth.requireActiveUser();
      const admin = user.role === 'admin';
      const client = window.AppAuth.client;
      const reuse = options.tables && lastRows && lastRows.userId === user.id && lastRows.admin === admin && Date.now() - lastRows.loadedAt < PARTIAL_RELOAD_MAX_AGE_MS;
      const rows = {};
      await Promise.all(SNAPSHOT_TABLES.map(async spec => {
        if (spec.adminOnly && !admin) { rows[spec.key] = []; return; }
        if (reuse && !options.tables.has(spec.key)) { rows[spec.key] = lastRows.rows[spec.key]; return; }
        rows[spec.key] = await query(client, spec.table, spec.fields);
      }));
      const { shopSettings } = rows;
      const state = snapshotFromRows({ ...rows, admin });
      lastRows = { userId: user.id, admin, rows, loadedAt: reuse ? lastRows.loadedAt : Date.now() };
      await window.InventoryStorage.saveState(state, user.id);
      return { state, hourlyRate: Number(shopSettings[0]?.hourly_rate ?? 0), source: 'cloud', readonly: false };
    } catch (error) {
      // 共用電腦上換人登入時，不可顯示上一位帳號（例如店長的成本、供應商）留下的快取。
      const currentUserId = user?.id ?? await sessionUserId();
      if (cache.state && cache.ownerId && cache.ownerId === currentUserId) return { state: cache.state, hourlyRate: 0, source: 'cache', readonly: true, error };
      throw error;
    }
  }

  async function setHourlyRate(rate) {
    const user = await window.AppAuth.requireActiveUser();
    if (user.role !== 'admin') throw new Error('只有店長可維護工時費率');
    if (!/^\d+(\.\d{1,2})?$/.test(String(rate)) || !Number.isFinite(Number(rate))) throw new Error('工時費率須為非負金額，最多兩位小數');
    const { data, error } = await window.AppAuth.client.from('shop_settings').update({ hourly_rate: Number(rate) }).eq('id', 1).select('hourly_rate').single();
    if (error) throw error;
    if (!data) throw new Error('工時費率未儲存');
    return Number(data.hourly_rate);
  }

  async function loadRepairOrders() {
    await window.AppAuth.requireActiveUser();
    const [orders, lines] = await Promise.all([
      query(window.AppAuth.client, 'repair_orders', 'id,repair_number,salesperson_id,customer_id,customer_name,customer_phone,plate_number,original_serial_number,vehicle_name,issue,diagnosis,labor_amount,total,status,payment_status,created_at,updated_at,quoted_at,completed_at,cancelled_at,paid_at'),
      query(window.AppAuth.client, 'repair_lines', 'id,repair_order_id,item_id,item_name,item_sku,quantity,unit_price,subtotal'),
    ]);
    return orders.map(row => ({
      id: row.id, number: row.repair_number, salespersonId: row.salesperson_id ?? '', customerId: row.customer_id ?? '', customerName: row.customer_name,
      customerPhone: row.customer_phone, plateNumber: row.plate_number, originalSerialNumber: row.original_serial_number,
      vehicleName: row.vehicle_name, issue: row.issue, diagnosis: row.diagnosis, laborAmount: Number(row.labor_amount),
      total: Number(row.total), status: row.status, paymentStatus: row.payment_status, createdAt: row.created_at,
      updatedAt: row.updated_at, quotedAt: row.quoted_at ?? '', completedAt: row.completed_at ?? '',
      cancelledAt: row.cancelled_at ?? '', paidAt: row.paid_at ?? '',
      lines: lines.filter(line => line.repair_order_id === row.id).map(line => ({ id: line.id, itemId: line.item_id,
        itemName: line.item_name, sku: line.item_sku, quantity: Number(line.quantity), unitPrice: Number(line.unit_price), subtotal: Number(line.subtotal) })),
    }));
  }

  async function repairMutation(name, args) {
    await window.AppAuth.requireActiveUser();
    const { data, error } = await window.AppAuth.client.rpc(name, args);
    if (error) throw error;
    try {
      const [orders, snapshot] = await Promise.all([loadRepairOrders(), loadSnapshot()]);
      if (snapshot.readonly) throw snapshot.error ?? new Error('雲端重新讀取失敗');
      return { id: data, orders, state: snapshot.state };
    } catch (reloadError) {
      reloadError.operationCommitted = true;
      throw reloadError;
    }
  }
  const saveRepairOrder = (order, lines, expectedUpdatedAt = null) => repairMutation('save_repair_order', { p_order: order, p_lines: lines, p_expected_updated_at: expectedUpdatedAt });
  const cancelRepairOrder = id => repairMutation('cancel_repair_order', { p_order_id: id });
  const deleteRepairOrder = id => repairMutation('delete_repair_order', { p_order_id: id });
  const completeRepairOrder = (id, serialIdsByLine) => repairMutation('complete_repair_order', { p_order_id: id, p_serial_ids_by_line: serialIdsByLine });
  const markRepairPaid = id => repairMutation('mark_repair_paid', { p_order_id: id });
  // 店長補登／更正維修單業務員（任何狀態皆可）。
  const assignRepairSalesperson = (id, salespersonId) => repairMutation('assign_repair_salesperson', { p_order_id: id, p_salesperson_id: salespersonId });

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const rows = (state, key) => state[key] ?? [];
  const byId = values => new Map(values.map(value => [value.id, value]));
  const itemRow = item => ({ id: item.id, name: item.name, category: item.category, sku: item.sku, barcode: item.barcode, price: item.price, ...(item.stock === undefined ? {} : { stock: item.stock }), minimum_stock: item.minimumStock, warranty_months: item.warrantyMonths ?? 0, notes: item.notes, supplier_id: item.supplierId || null });
  const customerRow = customer => ({ id: customer.id, member_number: customer.memberNumber, name: customer.name, phone: customer.phone, plate_numbers: customer.plateNumbers ?? [], address: customer.address, note: customer.note, active: customer.active });
  async function mutate(client, table, method, value) {
    const request = client.from(table)[method](value);
    const { error } = await request;
    if (error) throw error;
  }
  // 每個 RPC／資料表寫入會影響快照中的哪些表（依資料庫函式實際寫入的表整理）。
  // 沒列在這裡的操作（進貨、序號登錄、刪除保固等牽動較多表）一律整份重抓。
  const RPC_TOUCHES = {
    create_or_update_supplier: ['suppliers'],
    create_sale_with_serials: ['items', 'transactions', 'sales', 'saleLines', 'serials', 'warranties'],
    adjust_inventory: ['items', 'transactions'],
    issue_warranty_replacement: ['items', 'transactions', 'serials'],
    save_quotation: ['quotations', 'quotationLines'],
    save_warranty: ['warranties'],
    save_warranty_case: ['warrantyCases'],
    delete_warranty_case: ['warrantyCases'],
  };
  const TABLE_TOUCHES = { items: ['items'], item_costs: ['costs'], customers: ['customers'], salespeople: ['salespeople'] };

  async function replaceCore(previous, next, actorId) {
    // 記錄這次寫入動到哪些表，儲存完只重抓那些表；認不得的操作就整份重抓。
    const touched = new Set();
    let fullReload = false;
    const mark = keys => { if (keys) keys.forEach(key => touched.add(key)); else fullReload = true; };
    const baseClient = window.AppAuth.client;
    const client = {
      rpc: (name, args) => { mark(RPC_TOUCHES[name]); return baseClient.rpc(name, args); },
      from: table => { mark(TABLE_TOUCHES[table]); return baseClient.from(table); },
    };
    const oldPurchases = byId(rows(previous, 'purchases'));
    const receivedPurchases = rows(next, 'purchases').filter(purchase => purchase.status === 'received' && oldPurchases.get(purchase.id)?.status === 'draft');
    const receivedItemIds = new Set(receivedPurchases.flatMap(purchase => purchase.lines.map(line => line.itemId)));
    const oldSuppliers = byId(rows(previous, 'suppliers'));
    for (const supplier of rows(next, 'suppliers')) {
      if (same(oldSuppliers.get(supplier.id), supplier)) continue;
      const { error } = await client.rpc('create_or_update_supplier', { p_supplier: supplier });
      if (error) throw error;
    }
    const previousSales = byId(rows(previous, 'sales')), addedSales = rows(next, 'sales').filter(value => !previousSales.has(value.id));
    const previousTransactions = byId(rows(previous, 'transactions'));
    const addedTransactions = rows(next, 'transactions').filter(value => !previousTransactions.has(value.id));
    const saleItemIds = new Set(addedSales.map(value => value.itemId));
    if (addedSales.length) {
      const salespersonId = addedSales[0].salespersonId;
      if (!salespersonId || addedSales.some(value => value.salespersonId !== salespersonId)) throw new Error('一張銷售單必須指定同一位業務員。');
      const soldSerials = rows(next, 'serials').filter(serial => addedSales.some(sale => sale.serialIds?.includes(serial.id)));
      const customerId = addedSales[0].customerId || soldSerials[0]?.customerId || rows(next, 'warranties').find(warranty => addedSales.some(sale => sale.id === warranty.saleId))?.customerId || null;
      // 同一次結帳的所有明細共用一個 checkout id；雲端以它當銷售單 ID，重送同一個 id 不會重複扣庫存。
      const checkoutId = addedSales[0].checkoutId || addedSales[0].id;
      if (addedSales.some(value => (value.checkoutId || addedSales[0].id) !== checkoutId)) throw new Error('一次只能送出一張銷售單，請重新整理後再試。');
      const { error } = await client.rpc('create_sale_with_serials', { p_lines: addedSales.map(value => ({ item_id: value.itemId, quantity: value.quantity, serial_ids: value.serialIds ?? [] })), p_customer_id: customerId, p_salesperson_id: salespersonId, p_checkout_id: checkoutId });
      if (error) throw error;
    }
    for (const entry of addedTransactions.filter(value => !saleItemIds.has(value.itemId) && !value.purchaseId)) {
      const { error } = entry.type === 'warranty_out'
        ? await client.rpc('issue_warranty_replacement', { p_item_id: entry.itemId, p_quantity: entry.quantity, p_warranty_id: entry.warrantyId, p_serial_ids: entry.serialIds, p_note: entry.note })
        : await client.rpc('adjust_inventory', { p_item_id: entry.itemId, p_type: entry.type === 'adjust' ? 'set' : entry.type, p_quantity: entry.quantity, p_note: entry.note || '' });
      if (error) throw error;
    }
    const changedStock = new Set([...saleItemIds, ...addedTransactions.map(value => value.itemId), ...receivedItemIds]);
    const originalItems = byId(rows(previous, 'items'));
    const oldSerialIds = new Set(rows(previous, 'serials').map(serial => serial.id));
    const addedSerials = rows(next, 'serials').filter(serial => !oldSerialIds.has(serial.id) && !serial.purchaseId);
    const newSerializedItems = rows(next, 'items').filter(item => !originalItems.has(item.id) && addedSerials.some(serial => serial.itemId === item.id));
    const newSerializedItemIds = new Set(newSerializedItems.map(item => item.id));
    for (const item of newSerializedItems) {
      const serials = addedSerials.filter(serial => serial.itemId === item.id).map(serial => ({ id: serial.id, serialNumber: serial.serialNumber }));
      const { error } = await client.rpc('create_serialized_item', { p_item: itemRow(item), p_cost: item.cost, p_serials: serials });
      if (error) throw error;
    }
    // 既有品項更新時絕不送出 stock：畫面上的庫存可能已過期（別台裝置剛賣出），整列覆寫會吃掉那筆扣庫存。
    // 店長在品項編輯直接改庫存時，改以「差額」呼叫 adjust_inventory（鎖列、留異動紀錄、保留他人同時的異動）。
    const newItems = [], editedItems = [], stockEdits = [];
    for (const value of rows(next, 'items')) {
      if (receivedItemIds.has(value.id) || newSerializedItemIds.has(value.id)) continue;
      const original = originalItems.get(value.id);
      if (!original) { newItems.push(value); continue; }
      const { stock, ...fields } = value;
      const { stock: originalStock, ...originalFields } = original;
      if (!same(fields, originalFields)) editedItems.push(fields);
      if (!changedStock.has(value.id) && stock !== undefined && stock !== originalStock) stockEdits.push({ itemId: value.id, delta: stock - originalStock });
    }
    // 新品項才帶初始庫存；ignoreDuplicates 讓重送時不會覆寫已存在的品項。
    if (newItems.length) {
      const { error } = await client.from('items').upsert(newItems.map(itemRow), { onConflict: 'id', ignoreDuplicates: true });
      if (error) throw error;
    }
    for (const item of editedItems) {
      const { id, ...changes } = itemRow(item);
      const { error } = await client.from('items').update(changes).eq('id', id).select('id').single();
      if (error) throw error;
    }
    for (const edit of stockEdits) {
      const { error } = await client.rpc('adjust_inventory', { p_item_id: edit.itemId, p_type: edit.delta > 0 ? 'in' : 'out', p_quantity: Math.abs(edit.delta), p_note: '品項編輯調整庫存' });
      if (error) throw error;
    }
    const changedCosts = rows(next, 'items').filter(value => !receivedItemIds.has(value.id) && !newSerializedItemIds.has(value.id) && (!originalItems.has(value.id) || originalItems.get(value.id).cost !== value.cost));
    if (changedCosts.length) await mutate(client, 'item_costs', 'upsert', changedCosts.map(value => ({ item_id: value.id, cost: value.cost })));
    for (const itemId of new Set(addedSerials.filter(serial => !newSerializedItemIds.has(serial.itemId)).map(serial => serial.itemId))) {
      const serials = addedSerials.filter(serial => serial.itemId === itemId).map(serial => ({ id: serial.id, serialNumber: serial.serialNumber }));
      const { error } = await client.rpc('register_inventory_serials', { p_item_id: itemId, p_serials: serials });
      if (error) throw error;
    }
    const oldCustomers = byId(rows(previous, 'customers'));
    const changedCustomers = rows(next, 'customers').filter(value => !same(oldCustomers.get(value.id), value));
    const addedCustomers = changedCustomers.filter(value => !oldCustomers.has(value.id));
    const updatedCustomers = changedCustomers.filter(value => oldCustomers.has(value.id));
    if (addedCustomers.length) await mutate(client, 'customers', 'insert', addedCustomers.map(value => ({ ...customerRow(value), created_by: actorId })));
    for (const customer of updatedCustomers) {
      const { id, ...changes } = customerRow(customer);
      // 樂觀鎖定：只有雲端的 updated_at 仍是我們讀到的那個值才更新；被別人先改過就不覆蓋。
      const previousUpdatedAt = oldCustomers.get(id)?.updatedAt;
      let request = client.from('customers').update(changes).eq('id', id);
      if (previousUpdatedAt) request = request.eq('updated_at', previousUpdatedAt);
      const { data, error } = await request.select('id');
      if (error) throw error;
      if (!data?.length) throw new Error(`客戶「${customer.name}」剛被其他人修改過，畫面已更新為最新資料，請確認後再編輯。`);
    }
    const oldSalespeople = byId(rows(previous, 'salespeople'));
    const changedSalespeople = rows(next, 'salespeople').filter(value => !same(oldSalespeople.get(value.id), value));
    const salespersonRow = value => ({ id: value.id, name: value.name, active: value.active });
    const addedSalespeople = changedSalespeople.filter(value => !oldSalespeople.has(value.id));
    const updatedSalespeople = changedSalespeople.filter(value => oldSalespeople.has(value.id));
    if (addedSalespeople.length) await mutate(client, 'salespeople', 'insert', addedSalespeople.map(value => ({ ...salespersonRow(value), created_by: actorId })));
    if (updatedSalespeople.length) await mutate(client, 'salespeople', 'upsert', updatedSalespeople.map(salespersonRow));
    const oldQuotations = byId(rows(previous, 'quotations'));
    for (const quotation of rows(next, 'quotations')) {
      if (same(oldQuotations.get(quotation.id), quotation)) continue;
      const { error } = await client.rpc('save_quotation', { p_quotation: quotation, p_lines: quotation.lines });
      if (error) throw error;
    }
    for (const purchase of rows(next, 'purchases')) {
      const old = oldPurchases.get(purchase.id);
      if (!old || (old.status === 'draft' && purchase.status === 'draft' && !same(old, purchase))) {
        const { error } = await client.rpc('save_purchase', { p_purchase: purchase, p_lines: purchase.lines });
        if (error) throw error;
      }
      if (old?.status === 'draft' && purchase.status === 'received') {
        const serialNumbersByItem = {};
        for (const serial of rows(next, 'serials').filter(value => value.purchaseId === purchase.id && !oldSerialIds.has(value.id))) {
          (serialNumbersByItem[serial.itemId] ??= []).push(serial.serialNumber);
        }
        const { error } = await client.rpc('receive_purchase', { p_purchase_id: purchase.id, p_serial_numbers_by_item: serialNumbersByItem });
        if (error) throw error;
      }
      if (old?.paymentStatus === 'unpaid' && purchase.paymentStatus === 'paid') {
        const { error } = await client.rpc('mark_purchase_paid', { p_purchase_id: purchase.id });
        if (error) throw error;
      }
    }
    const nextPurchaseIds = new Set(rows(next, 'purchases').map(value => value.id));
    for (const purchase of rows(previous, 'purchases').filter(value => value.status === 'draft' && !nextPurchaseIds.has(value.id))) {
      const { error } = await client.rpc('delete_purchase_draft', { p_purchase_id: purchase.id });
      if (error) throw error;
    }
    const oldWarranties = byId(rows(previous, 'warranties'));
    for (const warranty of rows(next, 'warranties')) {
      if (same(oldWarranties.get(warranty.id), warranty)) continue;
      if (warranty.source === 'sale' && addedSales.some(sale => sale.id === warranty.saleId)) continue;
      const { error } = await client.rpc('save_warranty', { p_warranty: warranty });
      if (error) throw error;
    }
    const oldCases = byId(rows(previous, 'warrantyCases'));
    for (const repairCase of rows(next, 'warrantyCases')) {
      if (same(oldCases.get(repairCase.id), repairCase)) continue;
      const { error } = await client.rpc('save_warranty_case', { p_case: repairCase });
      if (error) throw error;
    }
    const nextCaseIds = new Set(rows(next, 'warrantyCases').map(value => value.id));
    for (const repairCase of rows(previous, 'warrantyCases').filter(value => !nextCaseIds.has(value.id))) {
      const { error } = await client.rpc('delete_warranty_case', { p_case_id: repairCase.id });
      if (error) throw error;
    }
    const nextWarrantyIds = new Set(rows(next, 'warranties').map(value => value.id));
    for (const warranty of rows(previous, 'warranties').filter(value => !nextWarrantyIds.has(value.id))) {
      const { error } = await client.rpc('delete_warranty', { p_warranty_id: warranty.id });
      if (error) throw error;
    }
    const result = await loadSnapshot(undefined, { tables: fullReload ? null : touched });
    if (result.readonly || addedSerials.some(serial => !result.state.serials?.some(saved => saved.id === serial.id && saved.itemId === serial.itemId && saved.serialNumber === serial.serialNumber))) {
      throw new Error('序號未在雲端確認，請重新整理核對後再操作。');
    }
    return result;
  }

  async function saveSnapshot(previous, next) {
    const user = await window.AppAuth.requireActiveUser();
    let result;
    try {
      result = await replaceCore(previous, next, user.id);
    } catch (error) {
      // 前面的步驟可能已在雲端完成（例如銷售成功、之後才斷線）。
      // 重新讀取雲端，讓畫面與雲端一致，使用者才不會以為沒成功而重送。
      try {
        const reloaded = await loadSnapshot(user);
        if (!reloaded.readonly) error.reloadedState = reloaded.state;
      } catch { /* 保留原本的錯誤訊息 */ }
      throw error;
    }
    if (result.readonly) throw result.error || new Error('雲端連線中斷');
    return result.state;
  }

  async function loadMonthlySalespersonPerformance(month) {
    const user = await window.AppAuth.requireActiveUser();
    if (user.role !== 'admin') throw new Error('只有店長可以查看業務員績效。');
    const { data, error } = await window.AppAuth.client.rpc('get_monthly_salesperson_performance', { p_month: month });
    if (error) throw error;
    return (data ?? []).map(row => ({ salespersonId: row.salesperson_id, name: row.salesperson_name, quantity: Number(row.quantity), total: Number(row.total) }));
  }

  // 業務員當月維修：完工日在當月的維修單件數與總額。
  async function loadMonthlySalespersonRepairs(month) {
    const user = await window.AppAuth.requireActiveUser();
    if (user.role !== 'admin') throw new Error('只有店長可以查看業務員績效。');
    const { data, error } = await window.AppAuth.client.rpc('get_monthly_salesperson_repairs', { p_month: month });
    if (error) throw error;
    return (data ?? []).map(row => ({ salespersonId: row.salesperson_id, name: row.salesperson_name, repairCount: Number(row.repair_count), repairTotal: Number(row.repair_total) }));
  }

  async function loadMonthlySaleAssignments(month) {
    const user = await window.AppAuth.requireActiveUser();
    if (user.role !== 'admin') throw new Error('只有店長可以查看銷售歸屬。');
    const { data, error } = await window.AppAuth.client.rpc('get_monthly_sale_assignments', { p_month: month });
    if (error) throw error;
    return (data ?? []).map(row => ({ saleNumber: row.sale_number, salespersonId: row.salesperson_id, name: row.salesperson_name }));
  }

  async function assignSaleSalesperson(saleNumber, salespersonId) {
    const user = await window.AppAuth.requireActiveUser();
    if (user.role !== 'admin') throw new Error('只有店長可以補登業務員。');
    const { error } = await window.AppAuth.client.rpc('assign_sale_salesperson', { p_sale_number: saleNumber, p_salesperson_id: salespersonId });
    if (error) throw error;
  }

  // 首次移轉只會「新增」雲端還沒有的營運資料。若備份裡的資料已在雲端（例如從雲端匯出的備份），
  // 資料庫會因編號重複整筆拒絕；這裡先用編號比對，改用中文說明，也不會多下載一份備份。
  const IMPORT_MODULES = [
    { key: 'suppliers', table: 'suppliers', label: '供應商' },
    { key: 'purchases', table: 'purchases', label: '進貨單' },
    { key: 'quotations', table: 'quotations', label: '報價單' },
    { key: 'serials', table: 'inventory_serials', label: '序號' },
    { key: 'warranties', table: 'warranties', label: '保固' },
    { key: 'warrantyCases', table: 'warranty_cases', label: '保固案件' },
    { key: 'transactions', table: 'inventory_transactions', label: '進貨／保固庫存異動', include: row => row.purchaseId || row.warrantyId },
  ];
  async function findAlreadyInCloud(client, state) {
    const found = [];
    for (const module of IMPORT_MODULES) {
      const ids = new Set((state[module.key] ?? []).filter(row => row?.id && (!module.include || module.include(row))).map(row => row.id));
      if (!ids.size) continue;
      const count = (await query(client, module.table, 'id')).filter(row => ids.has(row.id)).length;
      if (count) found.push(`${module.label} ${count} 筆`);
    }
    return found;
  }

  async function migrateLocalStateToCloud(source, createBackup) {
    const user = await window.AppAuth.requireActiveUser();
    if (user.role !== 'admin') throw new Error('只有店長可以執行首次資料移轉。');
    const state = window.Inventory.validateState(source);
    const { data: marker, error: markerError } = await window.AppAuth.client.from('app_migrations')
      .select('module').eq('module', 'cloud_operations').maybeSingle();
    if (markerError) throw markerError;
    if (marker) {
      try {
        const result = await loadSnapshot();
        if (result.readonly) throw result.error || new Error('雲端連線中斷');
        return { migrated: false, backupCreated: false, state: result.state };
      } catch (reloadError) {
        reloadError.reloadFailed = true;
        throw reloadError;
      }
    }
    if (typeof createBackup !== 'function') throw new Error('必須先建立本機備份。');
    const existing = await findAlreadyInCloud(window.AppAuth.client, state);
    if (existing.length) throw new Error(`這份備份的資料已經在雲端（${existing.join('、')}），不需要移轉；雲端資料沒有任何變更`);
    await createBackup(state);
    const { data: imported, error } = await window.AppAuth.client.rpc('import_cloud_operations', { p_state: state });
    // 23505＝編號重複：資料庫整筆取消，不會只匯入一半。
    if (error?.code === '23505') throw new Error('備份中有資料的編號已存在雲端，整筆移轉已取消，雲端資料沒有任何變更');
    if (error) throw error;
    try {
      const result = await loadSnapshot();
      if (result.readonly) throw result.error || new Error('雲端重新讀取失敗');
      return { migrated: imported === true, backupCreated: true, state: result.state };
    } catch (reloadError) {
      reloadError.importCommitted = true;
      reloadError.reloadFailed = true;
      throw reloadError;
    }
  }

  window.AppData = { loadSnapshot, saveSnapshot, setHourlyRate, loadRepairOrders, saveRepairOrder, cancelRepairOrder, deleteRepairOrder, completeRepairOrder, markRepairPaid, assignRepairSalesperson, loadMonthlySalespersonRepairs, loadMonthlySalespersonPerformance, loadMonthlySaleAssignments, assignSaleSalesperson, migrateLocalStateToCloud };
})();
