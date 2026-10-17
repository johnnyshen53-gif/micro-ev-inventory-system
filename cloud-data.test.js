import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadCloudData({ client, cache, inventory, requireActiveUser = async () => ({ id: 'admin', role: 'admin' }) }) {
  const context = {
    window: {
      AppAuth: { client, requireActiveUser },
      InventoryStorage: cache,
      Inventory: inventory,
    },
  };
  vm.runInNewContext(await readFile(new URL('./cloud-data.js', import.meta.url), 'utf8'), context);
  return context.window.AppData;
}

test('initial cloud snapshot reuses the user already validated during login', async () => {
  const tables = [];
  const appData = await loadCloudData({
    client: { from: table => ({ select: async () => { tables.push(table); return { data: [], error: null }; } }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => ({}), validateState: value => value },
    requireActiveUser: async () => { throw new Error('duplicate profile validation'); },
  });
  const result = await appData.loadSnapshot({ id: 'manager', role: 'admin' });
  assert.equal(result.source, 'cloud');
  assert.ok(tables.includes('item_costs'));
});

test('cloud repair-used serial and warranty retain repair links in the inventory snapshot', async () => {
  const at = '2026-10-16T05:00:00Z';
  const tables = {
    inventory_transactions: [{ id: 'tx-1', item_id: 'item-1', type: 'out', quantity: 1, note: '維修單', repair_order_id: 'repair-1', serial_ids: ['serial-1'], serial_numbers: ['BAT-001'], created_at: at }],
    inventory_serials: [{ id: 'serial-1', item_id: 'item-1', serial_number: 'BAT-001', status: 'repair_used', repair_order_id: 'repair-1', repair_used_at: at, warranty_id: 'warranty-1', created_by: 'staff-1', created_at: at }],
    warranties: [{ id: 'warranty-1', customer_id: 'customer-1', customer_name: '會員甲', item_id: 'item-1', item_name: '電池', source: 'repair', repair_order_id: 'repair-1', serial_id: 'serial-1', serial_number: 'BAT-001', purchased_at: '2026-10-16', expires_at: '2027-10-16', created_by: 'staff-1', created_at: at }],
  };
  const appData = await loadCloudData({
    client: { from: table => ({ select: async fields => {
      if (table === 'inventory_serials') assert.match(fields, /repair_used_at/);
      if (table === 'warranties') assert.match(fields, /repair_order_id/);
      return { data: tables[table] ?? [], error: null };
    } }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => ({ items: [], transactions: [], serials: [], warranties: [] }), validateState: value => value },
  });
  const { state } = await appData.loadSnapshot();
  assert.equal(state.transactions[0].repairOrderId, 'repair-1');
  assert.equal(state.serials[0].repairUsedAt, at);
  assert.equal(state.warranties[0].repairOrderId, 'repair-1');
  assert.equal(state.sales.length, 0);
});

test('cloud quotation reload keeps installation labor snapshots and current shop rate separate', async () => {
  const tables = {
    shop_settings: [{ id: 1, hourly_rate: 900 }],
    customers: [{ id: 'customer-1', name: '甲', phone: '0911' }],
    items: [{ id: 'item-1', name: '煞車皮', category: '零件', sku: 'P1', price: 350, stock: 2, minimum_stock: 0 }],
    quotations: [{ id: 'quote-1', quote_number: 'Q-1', customer_id: 'customer-1', total: 1550, note: '', created_at: '2026-10-16T00:00:00Z' }],
    quotation_lines: [{ quotation_id: 'quote-1', item_id: 'item-1', item_name: '煞車皮', quantity: 1, unit_price: 350, subtotal: 350,
      installation_required: true, labor_hours: 1.5, hourly_rate: 800, labor_amount: 1200 }],
  };
  const appData = await loadCloudData({
    client: { from: table => ({ select: async () => ({ data: tables[table] ?? [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => ({}), validateState: value => value },
  });
  const result = await appData.loadSnapshot();
  assert.equal(result.hourlyRate, 900);
  assert.equal(result.state.quotations[0].lines[0].hourlyRate, 800);
  assert.equal(result.state.quotations[0].lines[0].laborAmount, 1200);
});

test('shop hourly rate update returns the persisted rate and reports a denied write', async () => {
  let saved;
  const appData = await loadCloudData({
    client: { from: table => ({ update: value => { assert.equal(table, 'shop_settings'); saved = value.hourly_rate; return {
      eq: () => ({ select: () => ({ single: async () => ({ data: { hourly_rate: saved }, error: null }) }) }),
    }; } }) },
    cache: {}, inventory: {},
  });
  assert.equal(await appData.setHourlyRate(850), 850);
  assert.equal(saved, 850);
  await assert.rejects(() => appData.setHourlyRate(-1), /費率/);
});

test('repair adapter reads orders and uses guarded RPCs before reloading cloud state', async () => {
  const calls = [];
  const appData = await loadCloudData({
    client: {
      from: table => ({ select: async () => { calls.push(['read', table]); return { data: table === 'repair_orders' ? [{ id: 'repair-1', repair_number: 'R-1', status: 'quoted', total: 100 }] : table === 'repair_lines' ? [{ id: 'line-1', repair_order_id: 'repair-1', item_id: 'item-1', quantity: 1, unit_price: 100 }] : [], error: null }; } }),
      rpc: async (name, args) => { calls.push(['rpc', name, args]); return { data: 'repair-1', error: null }; },
    },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => ({ items: [], transactions: [], serials: [], warranties: [] }), validateState: value => value },
  });
  const rows = await appData.loadRepairOrders();
  assert.equal(rows[0].lines[0].itemId, 'item-1');
  await appData.saveRepairOrder({ status: 'intake' }, [], null);
  await appData.completeRepairOrder('repair-1', { 'line-1': ['serial-1'] });
  await appData.deleteRepairOrder('repair-1');
  assert.deepEqual(calls.filter(call => call[0] === 'rpc').map(call => call[1]), ['save_repair_order', 'complete_repair_order', 'delete_repair_order']);
  assert.ok(calls.filter(call => call[0] === 'read' && call[1] === 'repair_orders').length >= 3);
});

test('cloud read failure uses existing cache in read-only mode without overwriting it', async () => {
  const cached = { items: [], transactions: [], customers: [], salespeople: [], quotations: [], sales: [], warranties: [], warrantyCases: [], suppliers: [], purchases: [], serials: [] };
  let writes = 0;
  const appData = await loadCloudData({
    client: { from: () => { throw new Error('network unavailable'); } },
    cache: { loadState: async () => ({ state: cached, migrated: false }), saveState: async () => { writes += 1; } },
    inventory: { emptyState: () => cached, validateState: value => value },
  });

  const result = await appData.loadSnapshot();
  assert.equal(result.source, 'cache');
  assert.equal(result.readonly, true);
  assert.deepEqual(result.state, cached);
  assert.equal(writes, 0);
});

test('one-time import backs up validated data before its RPC and reloads cloud state', async () => {
  const source = { items: [{ id: 'item-1' }], suppliers: [] };
  const calls = [];
  const cloud = { items: [{ id: 'cloud-item' }] };
  const appData = await loadCloudData({
    client: {
      from: table => ({ select: () => table === 'app_migrations'
        ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }
        : Promise.resolve({ data: [], error: null }) }),
      rpc: async (name, args) => { calls.push(['rpc', name, args]); return { data: true, error: null }; },
    },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => cloud, validateState: value => value },
  });
  const result = await appData.migrateLocalStateToCloud(source, async data => { calls.push(['backup', data]); });
  assert.equal(result.migrated, true);
  assert.equal(result.backupCreated, true);
  assert.deepEqual(calls.map(call => call[0]), ['backup', 'rpc']);
  assert.equal(calls[1][1], 'import_cloud_operations');
  assert.equal(calls[1][2].p_state, source);
});

test('imported operational rows reload through the real inventory validator', async () => {
  const context = { window: {} };
  vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
  const now = '2026-10-15T00:00:00Z';
  const tables = {
    items: [{ id: 'item-1', name: '測試零件', category: '零件', sku: '', barcode: '', price: 20, stock: 0, minimum_stock: 0, warranty_months: 0, notes: '', supplier_id: 'supplier-1' }],
    item_costs: [{ item_id: 'item-1', cost: 10 }],
    customers: [{ id: 'customer-1', member_number: 'M000001', name: '客戶', phone: '0912345678', address: '', note: '', active: true, created_at: now, updated_at: now }],
    suppliers: [{ id: 'supplier-1', name: '供應商', contact: '', phone: '', address: '', tax_id: '', note: '', active: true, created_at: now, updated_at: now }],
    purchases: [{ id: 'purchase-1', purchase_number: 'P20261015001', supplier_id: 'supplier-1', supplier_snapshot: { name: '供應商', contact: '', phone: '', address: '', taxId: '' }, status: 'draft', payment_status: 'unpaid', total: 10, note: '', created_by: 'admin-1', received_by: null, paid_by: null, created_at: now, updated_at: now, received_at: null, paid_at: null }],
    purchase_lines: [{ purchase_id: 'purchase-1', item_id: 'item-1', item_name: '測試零件', item_sku: '', item_barcode: '', quantity: 1, unit_cost: 10, subtotal: 10 }],
    warranties: [{ id: 'warranty-1', customer_id: 'customer-1', customer_name: '客戶', item_id: 'item-1', item_name: '測試零件', barcode: '', source: 'manual', sale_line_id: null, sale_number: '', serial_id: null, serial_number: '', purchased_at: '2026-10-15', expires_at: '2027-10-15', note: '', created_by: 'admin-1', created_at: now }],
    warranty_cases: [{ id: 'case-1', warranty_id: 'warranty-1', issue: '無法使用', status: 'pending', handled_at: null, resolution_note: '', item_name: '測試零件', purchased_at: '2026-10-15', expires_at: '2027-10-15', created_by: 'admin-1', created_at: now, updated_at: now }],
  };
  const appData = await loadCloudData({
    client: { from: table => ({ select: async () => ({ data: tables[table] ?? [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: context.window.Inventory,
  });
  const { state } = await appData.loadSnapshot();
  assert.equal(state.purchases[0].lines[0].itemName, '測試零件');
  assert.equal(state.warrantyCases[0].warrantyId, 'warranty-1');
});

test('one-time import is admin-only and an existing marker skips upload and backup', async () => {
  const calls = [];
  const source = { items: [] };
  const context = { window: { AppAuth: { client: {
    from: table => ({ select: () => table === 'app_migrations'
      ? { eq: () => ({ maybeSingle: async () => ({ data: { module: 'cloud_operations' }, error: null }) }) }
      : Promise.resolve({ data: [], error: null }) }),
    rpc: async () => { calls.push('rpc'); return { error: null }; },
  }, requireActiveUser: async () => ({ role: 'clerk' }) },
  InventoryStorage: { loadState: async () => ({ state: null }), saveState: async () => {} },
  Inventory: { emptyState: () => source, validateState: value => value } } };
  vm.runInNewContext(await readFile(new URL('./cloud-data.js', import.meta.url), 'utf8'), context);
  await assert.rejects(() => context.window.AppData.migrateLocalStateToCloud(source, async () => calls.push('backup')), /店長/);
  context.window.AppAuth.requireActiveUser = async () => ({ role: 'admin' });
  const result = await context.window.AppData.migrateLocalStateToCloud(source, async () => calls.push('backup'));
  assert.equal(result.migrated, false);
  assert.deepEqual(calls, []);
});

test('failed one-time import does not replace the local cache', async () => {
  const source = { items: [{ id: 'local' }] };
  let writes = 0;
  const appData = await loadCloudData({
    client: {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
      rpc: async () => ({ error: new Error('import rejected') }),
    },
    cache: { loadState: async () => ({ state: source }), saveState: async () => { writes += 1; } },
    inventory: { emptyState: () => source, validateState: value => value },
  });
  await assert.rejects(() => appData.migrateLocalStateToCloud(source, async () => {}), /import rejected/);
  assert.equal(writes, 0);
});

test('successful import with failed cloud reload reports committed state for a safe UI lock', async () => {
  const source = { items: [] };
  let writes = 0;
  const appData = await loadCloudData({
    client: {
      from: table => ({ select: () => table === 'app_migrations'
        ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }
        : Promise.resolve({ data: null, error: new Error('reload offline') }) }),
      rpc: async () => ({ data: true, error: null }),
    },
    cache: { loadState: async () => ({ state: source }), saveState: async () => { writes += 1; } },
    inventory: { emptyState: () => source, validateState: value => value },
  });
  await assert.rejects(() => appData.migrateLocalStateToCloud(source, async () => {}), error => error.importCommitted === true);
  assert.equal(writes, 0);
});

test('cloud inventory adjustment does not upsert the stale stock value after the RPC', async () => {
  const item = { id: 'item-1', name: '測試品項', category: '零件', sku: 'SKU-1', barcode: 'BC-1', cost: 10, price: 20, stock: 1, minimumStock: 0, warrantyMonths: 0, notes: '' };
  const transaction = { id: 'tx-1', itemId: item.id, type: 'in', quantity: 2, note: '', createdAt: '2026-10-13T06:28:17.070Z' };
  const upserts = [];
  const emptyRows = { items: [], costs: [], transactions: [], customers: [], salespeople: [], sales: [], saleLines: [] };
  const client = {
    rpc: async () => ({ error: null }),
    from: (table) => ({
      upsert: async (value) => { upserts.push({ table, value }); return { error: null }; },
      select: async () => ({ data: emptyRows[table] ?? [], error: null }),
    }),
  };
  const appData = await loadCloudData({
    client,
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => ({ items: [], transactions: [], customers: [], salespeople: [], sales: [] }), validateState: value => value },
  });

  await appData.saveSnapshot(
    { items: [item], transactions: [], customers: [], salespeople: [], sales: [] },
    { items: [{ ...item, stock: 3 }], transactions: [transaction], customers: [], salespeople: [], sales: [] },
  );

  for (const entry of upserts.filter(entry => entry.table === 'items')) {
    for (const itemRow of entry.value) assert.equal('stock' in itemRow, false);
  }
});

test('new customers include the signed-in creator without changing existing customer ownership', async () => {
  const calls = [];
  const oldCustomer = { id: 'customer-1', memberNumber: 'M000001', name: '舊客戶', phone: '', address: '', note: '', active: true };
  const newCustomer = { id: 'customer-2', memberNumber: 'M000002', name: '新客戶', phone: '', address: '', plateNumbers: ['ABC-1234', 'DEF-5678'], note: '', active: true };
  const old = { items: [], transactions: [], customers: [oldCustomer], salespeople: [], sales: [] };
  const appData = await loadCloudData({
    client: {
      from: table => ({
        insert: async value => { calls.push({ table, method: 'insert', value }); return { error: null }; },
        upsert: async () => ({ error: new Error('new row violates row-level security policy for table "customers"') }),
        update: value => ({ eq: (field, id) => ({ select: () => ({ single: async () => {
          calls.push({ table, method: 'update', value, field, id });
          return { data: { id }, error: null };
        } }) }) }),
        select: async () => ({ data: [], error: null }),
      }),
    },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });

  await appData.saveSnapshot(old, { ...old, customers: [{ ...oldCustomer, name: '已更新' }, newCustomer] });

  const customerCalls = calls.filter(call => call.table === 'customers');
  assert.equal(customerCalls.length, 2);
  assert.equal(customerCalls.find(call => call.method === 'insert')?.value[0].created_by, 'admin');
  assert.deepEqual(customerCalls.find(call => call.method === 'insert')?.value[0].plate_numbers, ['ABC-1234', 'DEF-5678']);
  const update = customerCalls.find(call => call.method === 'update');
  assert.equal(update?.field, 'id');
  assert.equal(update?.id, 'customer-1');
  assert.deepEqual(JSON.parse(JSON.stringify(update?.value)), { member_number: 'M000001', name: '已更新', phone: '', plate_numbers: [], address: '', note: '', active: true });
});

test('salespeople insert, edit, and deactivate persist without rewriting creator or unchanged rows', async () => {
  const now = '2026-10-15T00:00:00Z';
  const old = { items: [], transactions: [], customers: [], salespeople: [{ id: 'unchanged', name: '保留', active: true, createdAt: now, updatedAt: now }, { id: 'edited', name: '舊名', active: true, createdAt: now, updatedAt: now }], sales: [] };
  const next = { ...old, salespeople: [old.salespeople[0], { ...old.salespeople[1], name: '新名', active: false }, { id: 'new', name: '新業務', active: true, createdAt: now, updatedAt: now }] };
  const tableRows = { salespeople: old.salespeople.map(value => ({ id: value.id, name: value.name, active: value.active, created_at: now, updated_at: now })) };
  const calls = [];
  const appData = await loadCloudData({
    client: { from: table => ({
      insert: async values => { calls.push({ table, method: 'insert', values }); tableRows[table] ??= []; tableRows[table].push(...values); return { error: null }; },
      upsert: async values => { calls.push({ table, method: 'upsert', values }); tableRows[table] = tableRows[table].filter(row => !values.some(value => value.id === row.id)).concat(values); return { error: null }; },
      select: async () => ({ data: tableRows[table] ?? [], error: null }),
    }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  const saved = await appData.saveSnapshot(old, next);
  const writes = calls.filter(call => call.table === 'salespeople');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.find(call => call.method === 'insert')?.values.map(value => [value.id, value.created_by]), [['new', 'admin']]);
  assert.deepEqual(writes.find(call => call.method === 'upsert')?.values.map(value => [value.id, value.active, 'created_by' in value]), [['edited', false, false]]);
  assert.deepEqual(saved.salespeople.map(value => value.id).sort(), ['edited', 'new', 'unchanged']);
});

test('salesperson RLS denial leaves local cache unchanged', async () => {
  const old = { items: [], transactions: [], customers: [], salespeople: [], sales: [] };
  let cacheWrites = 0;
  const appData = await loadCloudData({
    client: { from: table => ({
      insert: async () => ({ error: table === 'salespeople' ? new Error('row-level security policy') : null }),
      select: async () => ({ data: [], error: null }),
    }) },
    cache: { loadState: async () => ({ state: old }), saveState: async () => { cacheWrites += 1; } },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  await assert.rejects(() => appData.saveSnapshot(old, { ...old, salespeople: [{ id: 'new', name: '業務', active: true }] }), /row-level security/);
  assert.equal(cacheWrites, 0);
});

test('cloud reload retains supplier and quotation details', async () => {
  const now = '2026-10-15T00:00:00Z';
  const tables = {
    items: [{ id: 'item-1', name: '零件', category: '零件', sku: 'P1', barcode: 'P1', price: 20, stock: 1, minimum_stock: 0, warranty_months: 0, notes: '', supplier_id: 'supplier-1' }],
    item_costs: [], inventory_transactions: [],
    customers: [{ id: 'customer-1', member_number: 'C1', name: '客戶', phone: '123', address: '', plate_numbers: ['ABC-1234', 'DEF-5678'], note: '', active: true, created_at: now, updated_at: now }],
    salespeople: [{ id: 'salesperson-1', name: '業務', active: true, created_at: now, updated_at: now }],
    sales: [], sale_lines: [],
    suppliers: [{ id: 'supplier-1', name: '供應商', contact: '王先生', phone: '456', address: '台北', tax_id: '12345678', note: '備註', active: true, created_at: now, updated_at: now }],
    quotations: [{ id: 'quote-1', quote_number: 'Q1', customer_id: 'customer-1', salesperson_id: 'salesperson-1', total: 40, note: '交期', created_at: now }],
    quotation_lines: [{ quotation_id: 'quote-1', item_id: 'item-1', item_name: '零件', quantity: 2, unit_price: 20, subtotal: 40 }],
  };
  const appData = await loadCloudData({
    client: { from: table => ({ select: async () => ({ data: tables[table] ?? [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => ({ items: [], transactions: [], customers: [], salespeople: [], quotations: [], sales: [], warranties: [], warrantyCases: [], suppliers: [], purchases: [], serials: [] }), validateState: value => value },
  });
  const { state } = await appData.loadSnapshot();
  assert.equal(state.suppliers[0].contact, '王先生');
  assert.deepEqual(Array.from(state.customers[0].plateNumbers), ['ABC-1234', 'DEF-5678']);
  assert.equal(state.items[0].supplierId, 'supplier-1');
  assert.equal(state.quotations[0].customerName, '客戶');
  assert.equal(state.quotations[0].salespersonName, '業務');
  assert.equal(state.quotations[0].lines[0].subtotal, 40);
});

test('creating a quotation calls its RPC without rewriting unchanged items', async () => {
  const calls = [];
  const old = { items: [{ id: 'item-1', stock: 1 }], customers: [], suppliers: [], quotations: [], transactions: [], sales: [] };
  const quotation = { id: 'quote-1', lines: [{ itemId: 'item-1', quantity: 1 }], total: 20 };
  const appData = await loadCloudData({
    client: {
      rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; },
      from: table => ({ upsert: async value => { calls.push({ table, value }); return { error: null }; }, select: async () => ({ data: [], error: null }) }),
    },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  await appData.saveSnapshot(old, { ...old, quotations: [quotation] });
  assert.equal(calls.find(call => call.name === 'save_quotation')?.args.p_quotation.id, 'quote-1');
  assert.equal(calls.some(call => call.table === 'items'), false);
});

test('cloud reload retains purchase lines, receipt actor, and physical serials', async () => {
  const now = '2026-10-15T00:00:00Z';
  const tables = {
    items: [{ id: 'item-1', name: '電池', category: '電池', sku: 'B1', barcode: 'B1', price: 20, stock: 1, minimum_stock: 0, warranty_months: 0, notes: '', supplier_id: 'supplier-1' }],
    suppliers: [{ id: 'supplier-1', name: '供應商', contact: '', phone: '', address: '', tax_id: '', note: '', active: true, created_at: now, updated_at: now }],
    purchases: [{ id: 'purchase-1', purchase_number: 'P20261015001', supplier_id: 'supplier-1', supplier_snapshot: { name: '供應商', contact: '', phone: '', address: '', taxId: '' }, status: 'received', payment_status: 'unpaid', total: 10, note: '', created_by: 'admin-1', received_by: 'admin-1', paid_by: null, created_at: now, updated_at: now, received_at: now, paid_at: null }],
    purchase_lines: [{ purchase_id: 'purchase-1', item_id: 'item-1', item_name: '電池', item_sku: 'B1', item_barcode: 'B1', quantity: 1, unit_cost: 10, subtotal: 10 }],
    inventory_serials: [{ id: 'serial-1', item_id: 'item-1', serial_number: 'SN-1', status: 'in_stock', purchase_id: 'purchase-1', sale_id: null, customer_id: null, warranty_id: null, created_by: 'admin-1', created_at: now, sold_at: null }],
    inventory_transactions: [{ id: 'tx-1', item_id: 'item-1', type: 'in', quantity: 1, note: '進貨收貨：P20261015001', purchase_id: 'purchase-1', created_at: now }],
  };
  const appData = await loadCloudData({
    client: { from: table => ({ select: async () => ({ data: tables[table] ?? [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => ({ items: [], transactions: [], customers: [], salespeople: [], quotations: [], sales: [], warranties: [], warrantyCases: [], suppliers: [], purchases: [], serials: [] }), validateState: value => value },
  });
  const { state } = await appData.loadSnapshot();
  assert.equal(state.purchases[0].lines[0].barcode, 'B1');
  assert.equal(state.purchases[0].receivedBy, 'admin-1');
  assert.equal(state.serials[0].serialNumber, 'SN-1');
  assert.equal(state.transactions[0].purchaseId, 'purchase-1');
});

test('purchase receipt uses one RPC and never replays its stock transaction', async () => {
  const calls = [];
  const item = { id: 'item-1', stock: 0, cost: 5 };
  const oldPurchase = { id: 'purchase-1', status: 'draft', paymentStatus: 'unpaid', lines: [{ itemId: 'item-1', quantity: 1 }] };
  const old = { items: [item], customers: [], suppliers: [], quotations: [], transactions: [], sales: [], purchases: [oldPurchase], serials: [] };
  const next = { ...old, items: [{ ...item, stock: 1, cost: 10 }], purchases: [{ ...oldPurchase, status: 'received' }], transactions: [{ id: 'tx-1', itemId: 'item-1', type: 'in', quantity: 1, purchaseId: 'purchase-1' }], serials: [{ id: 'serial-1', itemId: 'item-1', serialNumber: 'SN-1', purchaseId: 'purchase-1' }] };
  const appData = await loadCloudData({
    client: { rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; }, from: table => ({ upsert: async value => { calls.push({ table, value }); return { error: null }; }, select: async () => ({ data: [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  await appData.saveSnapshot(old, next);
  assert.equal(calls.filter(call => call.name === 'receive_purchase').length, 1);
  assert.equal(calls.some(call => call.name === 'adjust_inventory'), false);
  assert.equal(calls.some(call => call.table === 'items'), false);
  assert.equal(calls.some(call => call.table === 'item_costs'), false);
});

test('new serialized item uses one cloud write for item, cost, and initial serials', async () => {
  const calls = [];
  const item = { id: 'item-new', name: '機車', category: '機車', sku: '11001', barcode: '11001', stock: 1, cost: 10, price: 20, minimumStock: 0 };
  const serial = { id: 'serial-new', itemId: item.id, serialNumber: 'FACTORY-1', status: 'in_stock' };
  const old = { items: [], serials: [] };
  const next = { ...old, items: [item], serials: [serial] };
  const appData = await loadCloudData({
    client: { rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; }, from: table => ({ upsert: async () => { calls.push({ table }); return { error: null }; }, select: async () => ({ data: [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  await assert.rejects(() => appData.saveSnapshot(old, next), /序號.*雲端/);
  assert.equal(calls.filter(call => call.name === 'create_serialized_item').length, 1);
  assert.equal(calls.some(call => call.table === 'items' || call.table === 'item_costs'), false);
});

test('existing serial registration reaches cloud and missing persistence is not reported as success', async () => {
  const calls = [];
  const item = { id: 'item-1', category: '電池', stock: 1, cost: 5 };
  const old = { items: [item], serials: [] };
  const next = { ...old, serials: [{ id: 'serial-1', itemId: item.id, serialNumber: 'FACTORY-2', status: 'in_stock' }] };
  const appData = await loadCloudData({
    client: { rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; }, from: () => ({ select: async () => ({ data: [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  await assert.rejects(() => appData.saveSnapshot(old, next), /序號.*雲端/);
  assert.equal(calls.filter(call => call.name === 'register_inventory_serials').length, 1);
});

test('cloud reload retains sold serial, warranty, and repair case relationships', async () => {
  const now = '2026-10-15T00:00:00Z';
  const tables = {
    items: [{ id: 'item-1', name: '電池', category: '電池', sku: 'B1', barcode: 'B1', price: 100, stock: 0, minimum_stock: 0, warranty_months: 12, notes: '' }],
    customers: [{ id: 'customer-1', member_number: 'M000001', name: '客戶', phone: '123', address: '', note: '', active: true, created_at: now, updated_at: now }],
    sales: [{ id: 'sale-header-1', sale_number: 'S1', customer_id: 'customer-1', created_by: 'user-1', created_at: now }],
    sale_lines: [{ id: 'sale-line-1', sale_id: 'sale-header-1', item_id: 'item-1', item_name: '電池', barcode: 'B1', quantity: 1, unit_price: 100, subtotal: 100 }],
    inventory_serials: [{ id: 'serial-1', item_id: 'item-1', serial_number: 'SN-1', status: 'sold', sale_line_id: 'sale-line-1', customer_id: 'customer-1', created_by: 'user-1', created_at: now, sold_at: now }],
    warranties: [{ id: 'warranty-1', customer_id: 'customer-1', customer_name: '客戶', item_id: 'item-1', item_name: '電池', barcode: 'B1', source: 'sale', sale_line_id: 'sale-line-1', sale_number: 'S1', serial_id: 'serial-1', serial_number: 'SN-1', purchased_at: '2026-10-15', expires_at: '2027-10-15', note: '', created_by: 'user-1', created_at: now }],
    warranty_cases: [{ id: 'case-1', warranty_id: 'warranty-1', issue: '無法充電', status: 'pending', handled_at: null, resolution_note: '', item_name: '電池', purchased_at: '2026-10-15', expires_at: '2027-10-15', created_by: 'user-1', created_at: now, updated_at: now }],
  };
  const appData = await loadCloudData({
    client: { from: table => ({ select: async () => ({ data: tables[table] ?? [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => ({ items: [], transactions: [], customers: [], salespeople: [], quotations: [], sales: [], warranties: [], warrantyCases: [], suppliers: [], purchases: [], serials: [] }), validateState: value => value },
  });
  const { state } = await appData.loadSnapshot();
  assert.deepEqual(Array.from(state.sales[0].serialIds), ['serial-1']);
  assert.equal(state.serials[0].saleId, 'sale-line-1');
  assert.equal(state.warranties[0].serialId, 'serial-1');
  assert.equal(state.warranties[0].expiresAt, '2027-10-15');
  assert.equal(state.warrantyCases[0].warrantyId, 'warranty-1');
});

test('manual warranty and repair case changes use their transaction RPCs', async () => {
  const calls = [];
  const old = { items: [], customers: [], suppliers: [], quotations: [], transactions: [], sales: [], purchases: [], serials: [], warranties: [], warrantyCases: [] };
  const warranty = { id: 'warranty-1', source: 'manual', customerId: 'customer-1', itemId: 'item-1' };
  const repairCase = { id: 'case-1', warrantyId: 'warranty-1', issue: '無法充電' };
  const appData = await loadCloudData({
    client: { rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; }, from: () => ({ select: async () => ({ data: [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  await appData.saveSnapshot(old, { ...old, warranties: [warranty], warrantyCases: [repairCase] });
  assert.equal(calls.find(call => call.name === 'save_warranty')?.args.p_warranty.id, 'warranty-1');
  assert.equal(calls.find(call => call.name === 'save_warranty_case')?.args.p_case.id, 'case-1');
});

test('serialized checkout sends selected serials and customer to atomic sale RPC', async () => {
  const calls = [];
  const item = { id: 'item-1', stock: 1 };
  const old = { items: [item], customers: [], suppliers: [], quotations: [], transactions: [], sales: [], purchases: [], serials: [{ id: 'serial-1', itemId: 'item-1', status: 'in_stock' }], warranties: [], warrantyCases: [] };
  const sale = { id: 'local-sale-line-1', itemId: 'item-1', quantity: 1, salespersonId: 'salesperson-1', serialIds: ['serial-1'], serialNumbers: ['SN-1'] };
  const next = { ...old, items: [{ ...item, stock: 0 }], sales: [sale], serials: [{ ...old.serials[0], status: 'sold', customerId: 'customer-1', saleId: sale.id }], transactions: [{ id: 'tx-1', itemId: 'item-1', type: 'out' }] };
  const appData = await loadCloudData({
    client: { rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; }, from: () => ({ select: async () => ({ data: [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  await appData.saveSnapshot(old, next);
  const call = calls.find(value => value.name === 'create_sale_with_serials');
  assert.equal(call?.args.p_customer_id, 'customer-1');
  assert.equal(call?.args.p_salesperson_id, 'salesperson-1');
  assert.deepEqual(Array.from(call.args.p_lines[0].serial_ids), ['serial-1']);
});

test('cloud checkout rejects mixed salesperson IDs before writing any sale', async () => {
  const old = { items: [], customers: [], transactions: [], sales: [] };
  let rpcCalls = 0;
  const appData = await loadCloudData({
    client: { rpc: async () => { rpcCalls += 1; return { error: null }; }, from: () => ({ select: async () => ({ data: [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  await assert.rejects(() => appData.saveSnapshot(old, { ...old, sales: [{ id: '1', itemId: 'a', quantity: 1, salespersonId: 'a' }, { id: '2', itemId: 'b', quantity: 1, salespersonId: 'b' }] }), /業務/);
  assert.equal(rpcCalls, 0);
});

test('monthly performance fetch requires admin and converts database numbers', async () => {
  let role = 'admin';
  const calls = [];
  const context = { window: {
    AppAuth: { requireActiveUser: async () => ({ role }), client: { rpc: async (name, args) => { calls.push([name, args]); return { data: [{ salesperson_id: 'person-1', salesperson_name: '張業務', quantity: '3', total: '250.00' }], error: null }; } } },
    InventoryStorage: {}, Inventory: {},
  } };
  vm.runInNewContext(await readFile(new URL('./cloud-data.js', import.meta.url), 'utf8'), context);
  const rows = await context.window.AppData.loadMonthlySalespersonPerformance('2026-10');
  assert.deepEqual(Array.from(rows, row => [row.salespersonId, row.name, row.quantity, row.total]), [['person-1', '張業務', 3, 250]]);
  assert.equal(calls[0][0], 'get_monthly_salesperson_performance');
  assert.equal(calls[0][1].p_month, '2026-10');
  role = 'clerk';
  await assert.rejects(() => context.window.AppData.loadMonthlySalespersonPerformance('2026-10'), /店長/);
  assert.equal(calls.length, 1);
});

test('only managers load and save whole-sale salesperson assignments', async () => {
  let role = 'admin';
  const calls = [];
  const context = { window: {
    AppAuth: { requireActiveUser: async () => ({ role }), client: { rpc: async (name, args) => {
      calls.push([name, args]);
      return { data: name === 'get_monthly_sale_assignments' ? [{ sale_number: 'S1', salesperson_id: null, salesperson_name: null }] : null, error: null };
    } } }, InventoryStorage: {}, Inventory: {},
  } };
  vm.runInNewContext(await readFile(new URL('./cloud-data.js', import.meta.url), 'utf8'), context);
  const assignments = await context.window.AppData.loadMonthlySaleAssignments('2026-10');
  assert.deepEqual(Array.from(assignments, row => [row.saleNumber, row.salespersonId]), [['S1', null]]);
  await context.window.AppData.assignSaleSalesperson('S1', 'person-1');
  assert.deepEqual(calls.map(([name]) => name), ['get_monthly_sale_assignments', 'assign_sale_salesperson']);
  assert.equal(calls[1][1].p_sale_number, 'S1');
  assert.equal(calls[1][1].p_salesperson_id, 'person-1');
  role = 'clerk';
  await assert.rejects(() => context.window.AppData.loadMonthlySaleAssignments('2026-10'), /店長/);
  await assert.rejects(() => context.window.AppData.assignSaleSalesperson('S1', 'person-1'), /店長/);
  assert.equal(calls.length, 2);
});

test('warranty replacement uses its atomic RPC rather than ordinary inventory adjustment', async () => {
  const calls = [];
  const item = { id: 'item-1', stock: 1 };
  const warranty = { id: 'warranty-1', itemId: 'item-1' };
  const serial = { id: 'serial-1', itemId: 'item-1', status: 'in_stock' };
  const old = { items: [item], customers: [], suppliers: [], quotations: [], transactions: [], sales: [], purchases: [], serials: [serial], warranties: [warranty], warrantyCases: [] };
  const entry = { id: 'tx-1', itemId: 'item-1', type: 'warranty_out', quantity: 1, warrantyId: 'warranty-1', serialIds: ['serial-1'], note: '故障更換' };
  const appData = await loadCloudData({
    client: { rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; }, from: () => ({ select: async () => ({ data: [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  await appData.saveSnapshot(old, { ...old, items: [{ ...item, stock: 0 }], transactions: [entry], serials: [{ ...serial, status: 'warranty_out' }] });
  assert.equal(calls.find(call => call.name === 'issue_warranty_replacement')?.args.p_warranty_id, 'warranty-1');
  assert.equal(calls.some(call => call.name === 'adjust_inventory'), false);
});
