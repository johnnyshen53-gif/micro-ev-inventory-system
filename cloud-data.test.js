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

  const itemUpsert = upserts.find(entry => entry.table === 'items').value[0];
  assert.equal('stock' in itemUpsert, false);
});
