(() => {
  const empty = () => window.Inventory.emptyState();

  function transactionType(type) {
    return type === 'set' ? 'adjust' : type;
  }

  function snapshotFromRows({ items, costs, transactions, customers, salespeople, sales, saleLines }) {
    const costByItem = new Map(costs.map(row => [row.item_id, Number(row.cost)]));
    const itemById = new Map(items.map(row => [row.id, row]));
    const linesBySale = new Map();
    saleLines.forEach(line => linesBySale.set(line.sale_id, [...(linesBySale.get(line.sale_id) ?? []), line]));
    return window.Inventory.validateState({
      ...empty(),
      items: items.map(row => ({ id: row.id, name: row.name, category: row.category, sku: row.sku, barcode: row.barcode, cost: costByItem.get(row.id) ?? 0, price: Number(row.price), stock: Number(row.stock), minimumStock: Number(row.minimum_stock), warrantyMonths: Number(row.warranty_months ?? 0), notes: row.notes })),
      transactions: transactions.map(row => ({ id: row.id, itemId: row.item_id, type: transactionType(row.type), quantity: Number(row.quantity), note: row.note, createdAt: row.created_at })),
      customers: customers.map(row => ({ id: row.id, memberNumber: row.member_number, name: row.name, phone: row.phone, address: row.address, note: row.note, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })),
      salespeople: salespeople.map(row => ({ id: row.id, name: row.name, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at })),
      sales: sales.flatMap(sale => (linesBySale.get(sale.id) ?? []).map(line => ({ id: line.id, itemId: line.item_id, itemName: line.item_name, barcode: line.barcode, quantity: Number(line.quantity), unitPrice: Number(line.unit_price), subtotal: Number(line.subtotal), createdAt: sale.created_at, createdBy: sale.created_by, createdByAccount: '', serialIds: [], serialNumbers: [] }))),
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
      await window.AppAuth.requireActiveUser();
      const client = window.AppAuth.client;
      const [items, costs, transactions, customers, salespeople, sales, saleLines] = await Promise.all([
        query(client, 'items', 'id,name,category,sku,barcode,price,stock,minimum_stock,warranty_months,notes'),
        query(client, 'item_costs', 'item_id,cost'), query(client, 'inventory_transactions', 'id,item_id,type,quantity,note,created_at'),
        query(client, 'customers', 'id,member_number,name,phone,address,note,active,created_at,updated_at'),
        query(client, 'salespeople', 'id,name,active,created_at,updated_at'), query(client, 'sales', 'id,created_by,created_at'),
        query(client, 'sale_lines', 'id,sale_id,item_id,item_name,barcode,quantity,unit_price,subtotal'),
      ]);
      const state = snapshotFromRows({ items, costs, transactions, customers, salespeople, sales, saleLines });
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
  const itemRow = item => ({ id: item.id, name: item.name, category: item.category, sku: item.sku, barcode: item.barcode, price: item.price, ...(item.stock === undefined ? {} : { stock: item.stock }), minimum_stock: item.minimumStock, warranty_months: item.warrantyMonths ?? 0, notes: item.notes });
  const customerRow = customer => ({ id: customer.id, member_number: customer.memberNumber, name: customer.name, phone: customer.phone, address: customer.address, note: customer.note, active: customer.active });
  async function mutate(client, table, method, value) {
    const request = client.from(table)[method](value);
    const { error } = await request;
    if (error) throw error;
  }
  async function replaceCore(previous, next) {
    const client = window.AppAuth.client;
    const previousSales = byId(rows(previous, 'sales')), addedSales = rows(next, 'sales').filter(value => !previousSales.has(value.id));
    const previousTransactions = byId(rows(previous, 'transactions'));
    const addedTransactions = rows(next, 'transactions').filter(value => !previousTransactions.has(value.id));
    const saleItemIds = new Set(addedSales.map(value => value.itemId));
    if (addedSales.length) {
      const { error } = await client.rpc('create_sale', { p_lines: addedSales.map(value => ({ item_id: value.itemId, quantity: value.quantity })), p_customer_id: addedSales[0].customerId || null });
      if (error) throw error;
    }
    for (const entry of addedTransactions.filter(value => !saleItemIds.has(value.itemId))) {
      const { error } = await client.rpc('adjust_inventory', { p_item_id: entry.itemId, p_type: entry.type === 'adjust' ? 'set' : entry.type, p_quantity: entry.quantity, p_note: entry.note || '' });
      if (error) throw error;
    }
    const changedStock = new Set([...saleItemIds, ...addedTransactions.map(value => value.itemId)]);
    const originalItems = byId(rows(previous, 'items'));
    const desiredItems = rows(next, 'items').map(value => {
      if (!changedStock.has(value.id) || !originalItems.has(value.id)) return value;
      const { stock, ...itemWithoutStock } = value;
      return itemWithoutStock;
    });
    await mutate(client, 'items', 'upsert', desiredItems.map(itemRow));
    await mutate(client, 'item_costs', 'upsert', desiredItems.map(value => ({ item_id: value.id, cost: value.cost })));
    await mutate(client, 'customers', 'upsert', rows(next, 'customers').map(customerRow));
    return loadSnapshot();
  }

  async function saveSnapshot(previous, next) {
    await window.AppAuth.requireActiveUser();
    const result = await replaceCore(previous, next);
    if (result.readonly) throw result.error || new Error('雲端連線中斷');
    return result.state;
  }

  window.AppData = { loadSnapshot, saveSnapshot };
})();
