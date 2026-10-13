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
