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
      transactions: transactions.map(row => ({ id: row.id, itemId: row.item_id, type: transactionType(row.type, row.warranty_id), quantity: Number(row.quantity), note: row.note, purchaseId: admin ? row.purchase_id ?? '' : '', warrantyId: row.warranty_id ?? '', customerId: row.customer_id ?? '', customerName: customerById.get(row.customer_id)?.name ?? '', itemName: row.item_name ?? '', expiresAt: row.expires_at ?? '', unitCostSnapshot: row.unit_cost_snapshot == null ? undefined : Number(row.unit_cost_snapshot), createdBy: row.created_by ?? '', createdByAccount: '', serialIds: row.serial_ids ?? [], serialNumbers: row.serial_numbers ?? [], createdAt: row.created_at })),
      customers: customers.map(row => ({ id: row.id, memberNumber: row.member_number, name: row.name, phone: row.phone, address: row.address, note: row.note, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })),
      salespeople: salespeople.map(row => ({ id: row.id, name: row.name, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })),
      suppliers: suppliers.map(row => ({ id: row.id, name: row.name, contact: row.contact, phone: row.phone, address: row.address, taxId: row.tax_id, note: row.note, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })),
      purchases: purchases.map(row => ({ id: row.id, number: row.purchase_number, supplierId: row.supplier_id, supplierSnapshot: row.supplier_snapshot, status: row.status, paymentStatus: row.payment_status, lines: (linesByPurchase.get(row.id) ?? []).map(line => ({ itemId: line.item_id, itemName: line.item_name, sku: line.item_sku, barcode: line.item_barcode, quantity: Number(line.quantity), unitCost: Number(line.unit_cost), subtotal: Number(line.subtotal) })), total: Number(row.total), note: row.note, createdAt: row.created_at, updatedAt: row.updated_at, receivedAt: row.received_at ?? '', paidAt: row.paid_at ?? '', createdBy: row.created_by, receivedBy: row.received_by ?? '', paidBy: row.paid_by ?? '', createdByAccount: '', receivedByAccount: '', paidByAccount: '' })),
      serials: serials.map(row => ({ id: row.id, itemId: row.item_id, serialNumber: row.serial_number, status: row.status, purchaseId: admin ? row.purchase_id ?? '' : '', saleId: row.sale_line_id ?? '', customerId: row.customer_id ?? '', warrantyId: row.warranty_id ?? '', createdBy: row.created_by, createdAt: row.created_at, soldAt: row.sold_at ?? '', removedAt: row.removed_at ?? '', removedBy: row.removed_by ?? '', removalReason: row.removal_reason ?? '' })),
      quotations: quotations.map(row => ({ id: row.id, number: row.quote_number, customerId: row.customer_id, customerName: customerById.get(row.customer_id)?.name ?? '', customerPhone: customerById.get(row.customer_id)?.phone ?? '', salespersonId: row.salesperson_id ?? '', salespersonName: row.salesperson_id ? salespersonById.get(row.salesperson_id)?.name ?? '' : '', lines: (linesByQuotation.get(row.id) ?? []).map(line => ({ itemId: line.item_id, itemName: line.item_name, quantity: Number(line.quantity), unitPrice: Number(line.unit_price), subtotal: Number(line.subtotal) })), total: Number(row.total), note: row.note, createdAt: row.created_at })),
      sales: sales.flatMap(sale => (linesBySale.get(sale.id) ?? []).map(line => ({ id: line.id, saleNumber: sale.sale_number, customerId: sale.customer_id ?? '', itemId: line.item_id, itemName: line.item_name, barcode: line.barcode, quantity: Number(line.quantity), unitPrice: Number(line.unit_price), subtotal: Number(line.subtotal), createdAt: sale.created_at, createdBy: sale.created_by, createdByAccount: '', serialIds: (serialsBySaleLine.get(line.id) ?? []).map(serial => serial.id), serialNumbers: (serialsBySaleLine.get(line.id) ?? []).map(serial => serial.serial_number) }))),
      warranties: warranties.map(row => ({ id: row.id, customerId: row.customer_id, customerName: row.customer_name, itemId: row.item_id, itemName: row.item_name, barcode: row.barcode, source: row.source, saleId: row.sale_line_id ?? '', saleNumber: row.sale_number, serialId: row.serial_id ?? '', serialNumber: row.serial_number ?? '', purchasedAt: row.purchased_at, expiresAt: row.expires_at, note: row.note, createdBy: row.created_by, createdAt: row.created_at })),
      warrantyCases: warrantyCases.map(row => ({ id: row.id, warrantyId: row.warranty_id, issue: row.issue, status: row.status, handledAt: row.handled_at ?? '', resolutionNote: row.resolution_note, itemName: row.item_name, purchasedAt: row.purchased_at, expiresAt: row.expires_at, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at })),
    });
  }

  async function query(client, table, fields) {
    const { data, error } = await client.from(table).select(fields);
    if (error) throw error;
    return data ?? [];
  }

  async function loadSnapshot() {
    const cache = await window.InventoryStorage.loadState();
    try {
      const user = await window.AppAuth.requireActiveUser();
      const admin = user.role === 'admin';
      const client = window.AppAuth.client;
      const [items, costs, transactions, customers, salespeople, sales, saleLines, suppliers, quotations, quotationLines, purchases, purchaseLines, serials, warranties, warrantyCases] = await Promise.all([
        query(client, 'items', 'id,name,category,sku,barcode,price,stock,minimum_stock,warranty_months,notes,supplier_id'),
        admin ? query(client, 'item_costs', 'item_id,cost') : [], query(client, 'inventory_transactions', 'id,item_id,type,quantity,note,purchase_id,warranty_id,customer_id,item_name,expires_at,unit_cost_snapshot,serial_ids,serial_numbers,created_by,created_at'),
        query(client, 'customers', 'id,member_number,name,phone,address,note,active,created_at,updated_at'),
        query(client, 'salespeople', 'id,name,active,created_at,updated_at'), query(client, 'sales', 'id,sale_number,customer_id,created_by,created_at'),
        query(client, 'sale_lines', 'id,sale_id,item_id,item_name,barcode,quantity,unit_price,subtotal'),
        admin ? query(client, 'suppliers', 'id,name,contact,phone,address,tax_id,note,active,created_at,updated_at') : [],
        query(client, 'quotations', 'id,quote_number,customer_id,salesperson_id,total,note,created_at'),
        query(client, 'quotation_lines', 'quotation_id,item_id,item_name,quantity,unit_price,subtotal'),
        admin ? query(client, 'purchases', 'id,purchase_number,supplier_id,supplier_snapshot,status,payment_status,total,note,created_by,received_by,paid_by,created_at,updated_at,received_at,paid_at') : [],
        admin ? query(client, 'purchase_lines', 'purchase_id,item_id,item_name,item_sku,item_barcode,quantity,unit_cost,subtotal') : [],
        query(client, 'inventory_serials', 'id,item_id,serial_number,status,purchase_id,sale_line_id,customer_id,warranty_id,created_by,created_at,sold_at,removed_at,removed_by,removal_reason'),
        query(client, 'warranties', 'id,customer_id,customer_name,item_id,item_name,barcode,source,sale_line_id,sale_number,serial_id,serial_number,purchased_at,expires_at,note,created_by,created_at'),
        query(client, 'warranty_cases', 'id,warranty_id,issue,status,handled_at,resolution_note,item_name,purchased_at,expires_at,created_by,created_at,updated_at'),
      ]);
      const state = snapshotFromRows({ items, costs, transactions, customers, salespeople, sales, saleLines, suppliers, quotations, quotationLines, purchases, purchaseLines, serials, warranties, warrantyCases, admin });
      await window.InventoryStorage.saveState(state);
      return { state, source: 'cloud', readonly: false };
    } catch (error) {
      if (cache.state) return { state: cache.state, source: 'cache', readonly: true, error };
      throw error;
    }
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const rows = (state, key) => state[key] ?? [];
  const byId = values => new Map(values.map(value => [value.id, value]));
  const itemRow = item => ({ id: item.id, name: item.name, category: item.category, sku: item.sku, barcode: item.barcode, price: item.price, ...(item.stock === undefined ? {} : { stock: item.stock }), minimum_stock: item.minimumStock, warranty_months: item.warrantyMonths ?? 0, notes: item.notes, supplier_id: item.supplierId || null });
  const customerRow = customer => ({ id: customer.id, member_number: customer.memberNumber, name: customer.name, phone: customer.phone, address: customer.address, note: customer.note, active: customer.active });
  async function mutate(client, table, method, value) {
    const request = client.from(table)[method](value);
    const { error } = await request;
    if (error) throw error;
  }
  async function replaceCore(previous, next) {
    const client = window.AppAuth.client;
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
      const soldSerials = rows(next, 'serials').filter(serial => addedSales.some(sale => sale.serialIds?.includes(serial.id)));
      const customerId = addedSales[0].customerId || soldSerials[0]?.customerId || rows(next, 'warranties').find(warranty => addedSales.some(sale => sale.id === warranty.saleId))?.customerId || null;
      const { error } = await client.rpc('create_sale_with_serials', { p_lines: addedSales.map(value => ({ item_id: value.itemId, quantity: value.quantity, serial_ids: value.serialIds ?? [] })), p_customer_id: customerId });
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
    const desiredItems = rows(next, 'items').map(value => {
      if (!changedStock.has(value.id) || !originalItems.has(value.id)) return value;
      const { stock, ...itemWithoutStock } = value;
      return itemWithoutStock;
    }).filter(value => {
      if (receivedItemIds.has(value.id) || newSerializedItemIds.has(value.id)) return false;
      const original = originalItems.get(value.id);
      if (!original) return true;
      const { stock, ...withoutStock } = original;
      return !same(value, value.stock === undefined ? withoutStock : original);
    });
    if (desiredItems.length) await mutate(client, 'items', 'upsert', desiredItems.map(itemRow));
    const changedCosts = rows(next, 'items').filter(value => !receivedItemIds.has(value.id) && !newSerializedItemIds.has(value.id) && (!originalItems.has(value.id) || originalItems.get(value.id).cost !== value.cost));
    if (changedCosts.length) await mutate(client, 'item_costs', 'upsert', changedCosts.map(value => ({ item_id: value.id, cost: value.cost })));
    for (const itemId of new Set(addedSerials.filter(serial => !newSerializedItemIds.has(serial.itemId)).map(serial => serial.itemId))) {
      const serials = addedSerials.filter(serial => serial.itemId === itemId).map(serial => ({ id: serial.id, serialNumber: serial.serialNumber }));
      const { error } = await client.rpc('register_inventory_serials', { p_item_id: itemId, p_serials: serials });
      if (error) throw error;
    }
    const oldCustomers = byId(rows(previous, 'customers'));
    const changedCustomers = rows(next, 'customers').filter(value => !same(oldCustomers.get(value.id), value));
    if (changedCustomers.length) await mutate(client, 'customers', 'upsert', changedCustomers.map(customerRow));
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
    const result = await loadSnapshot();
    if (result.readonly || addedSerials.some(serial => !result.state.serials?.some(saved => saved.id === serial.id && saved.itemId === serial.itemId && saved.serialNumber === serial.serialNumber))) {
      throw new Error('序號未在雲端確認，請重新整理核對後再操作。');
    }
    return result;
  }

  async function saveSnapshot(previous, next) {
    await window.AppAuth.requireActiveUser();
    const result = await replaceCore(previous, next);
    if (result.readonly) throw result.error || new Error('雲端連線中斷');
    return result.state;
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
    await createBackup(state);
    const { data: imported, error } = await window.AppAuth.client.rpc('import_cloud_operations', { p_state: state });
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

  window.AppData = { loadSnapshot, saveSnapshot, migrateLocalStateToCloud };
})();
