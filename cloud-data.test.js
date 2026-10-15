import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadCloudData({ client, cache, inventory }) {
  const context = {
    window: {
      AppAuth: { client, requireActiveUser: async () => ({ id: 'admin', role: 'admin' }) },
      InventoryStorage: cache,
      Inventory: inventory,
    },
  };
  vm.runInNewContext(await readFile(new URL('./cloud-data.js', import.meta.url), 'utf8'), context);
  return context.window.AppData;
}

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

test('cloud reload retains supplier and quotation details', async () => {
  const now = '2026-10-15T00:00:00Z';
  const tables = {
    items: [{ id: 'item-1', name: '零件', category: '零件', sku: 'P1', barcode: 'P1', price: 20, stock: 1, minimum_stock: 0, warranty_months: 0, notes: '', supplier_id: 'supplier-1' }],
    item_costs: [], inventory_transactions: [],
    customers: [{ id: 'customer-1', member_number: 'C1', name: '客戶', phone: '123', address: '', note: '', active: true, created_at: now, updated_at: now }],
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
  const sale = { id: 'local-sale-line-1', itemId: 'item-1', quantity: 1, serialIds: ['serial-1'], serialNumbers: ['SN-1'] };
  const next = { ...old, items: [{ ...item, stock: 0 }], sales: [sale], serials: [{ ...old.serials[0], status: 'sold', customerId: 'customer-1', saleId: sale.id }], transactions: [{ id: 'tx-1', itemId: 'item-1', type: 'out' }] };
  const appData = await loadCloudData({
    client: { rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; }, from: () => ({ select: async () => ({ data: [], error: null }) }) },
    cache: { loadState: async () => ({ state: null }), saveState: async () => {} },
    inventory: { emptyState: () => old, validateState: value => value },
  });
  await appData.saveSnapshot(old, next);
  const call = calls.find(value => value.name === 'create_sale_with_serials');
  assert.equal(call?.args.p_customer_id, 'customer-1');
  assert.deepEqual(Array.from(call.args.p_lines[0].serial_ids), ['serial-1']);
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
