import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

function clone(value) { return value === undefined ? value : structuredClone(value); }

function createIndexedDb() {
  let failNextWrite = false;
  const databases = new Map();
  const schedule = (callback) => queueMicrotask(callback);
  const request = (run) => {
    const result = {};
    schedule(() => { try { result.result = run(); result.onsuccess?.({ target: result }); } catch (error) { result.error = error; result.onerror?.({ target: result }); } });
    return result;
  };
  return {
    failNextWrite() { failNextWrite = true; },
    open(name) {
      const openRequest = {};
      schedule(() => {
        let database = databases.get(name);
        if (!database) {
          const stores = new Map();
          database = {
            objectStoreNames: { contains: (store) => stores.has(store) },
            createObjectStore(store) { stores.set(store, new Map()); },
            transaction(store, mode) {
              const transaction = {};
              transaction.objectStore = () => ({
                get: (key) => request(() => clone(stores.get(store).get(key))),
                put: (value, key) => request(() => { if (failNextWrite && mode === 'readwrite') { failNextWrite = false; throw new Error('write failed'); } stores.get(store).set(key, clone(value)); return key; }),
              });
              setTimeout(() => transaction.oncomplete?.(), 0);
              return transaction;
            },
          };
          databases.set(name, database);
          openRequest.result = database;
          openRequest.onupgradeneeded?.({ target: openRequest });
        }
        openRequest.result = database;
        openRequest.onsuccess?.({ target: openRequest });
      });
      return openRequest;
    },
  };
}

async function createStorage({ legacy } = {}) {
  const values = new Map(legacy === undefined ? [] : [['motorcycleInventory', legacy]]);
  const indexedDB = createIndexedDb();
  const context = {
    crypto: webcrypto,
    indexedDB,
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    window: {},
  };
  vm.runInNewContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
  vm.runInNewContext(await readFile(new URL('./storage.js', import.meta.url), 'utf8'), context);
  return { storage: context.window.InventoryStorage, indexedDB, legacy: values, state: context.window.Inventory.emptyState(), inventory: context.window.Inventory };
}

test('migrates valid legacy localStorage data once without deleting it', async () => {
  const { storage, legacy, state } = await createStorage({ legacy: JSON.stringify(stateWithItem()) });
  const result = await storage.loadState();

  assert.equal(result.migrated, true);
  assert.deepEqual(result.state.items[0].name, '機油');
  assert.equal(legacy.get('motorcycleInventory'), JSON.stringify(stateWithItem()));
  assert.equal((await storage.loadState()).migrated, false);
});

test('serial checkout and warranty persist together and write failures preserve all original units', async () => {
  const { storage, indexedDB, inventory: I } = await createStorage();
  let state = I.addItem(I.emptyState(), { name: '機車', category: '機車', sku: 'M', barcode: 'motor', cost: 1, price: 2, stock: 3, minimumStock: 0, warrantyMonths: 12, serialNumbers: ['000A', 'B', 'C'] });
  state = I.addCustomer(state, { name: '客戶', phone: '0912345678' });
  state = I.addSalesperson(state, { name: '測試業務' });
  state = I.recordTransaction(state, { itemId: state.items[0].id, type: 'out', quantity: 1, serialIds: [state.serials[2].id], note: '報廢', createdBy: 'manager' });
  await storage.saveState(state);
  const next = I.recordSaleBatch(state, { customerId: state.customers[0].id, salespersonId: state.salespeople[0].id, lines: [{ itemId: state.items[0].id, quantity: 1, serialIds: [state.serials[0].id] }] });
  indexedDB.failNextWrite(); await assert.rejects(() => storage.saveState(next), /write failed/);
  let stored = (await storage.loadState()).state;
  assert.equal(stored.items[0].stock, 2); assert.equal(stored.serials[0].status, 'in_stock'); assert.equal(stored.warranties.length, 0);
  await storage.saveState(I.validateState(JSON.parse(I.toBackup(next))));
  stored = (await storage.loadState()).state;
  assert.equal(stored.items[0].stock, 1); assert.equal(stored.serials[0].status, 'sold'); assert.equal(stored.serials[1].status, 'in_stock'); assert.equal(stored.serials[2].status, 'removed');
  assert.equal(stored.sales[0].serialNumbers[0], '000A'); assert.equal(stored.warranties[0].serialNumber, '000A');
});

test('prefers existing IndexedDB data over localStorage', async () => {
  const { storage, state } = await createStorage({ legacy: JSON.stringify(stateWithItem()) });
  await storage.saveState(state);

  assert.equal(JSON.stringify((await storage.loadState()).state), JSON.stringify(state));
});

test('warranty replacement stock serial linkage and cost snapshot persist atomically', async () => {
  const { storage, indexedDB, inventory: I } = await createStorage();
  let state = I.addItem(I.emptyState(), { name: '機車', category: '機車', sku: 'M', cost: 600, price: 1000, stock: 2, minimumStock: 0, warrantyMonths: 12, serialNumbers: ['000A', 'B'] });
  state = I.addCustomer(state, { name: '客戶', phone: '0912345678' });
  state = I.addSalesperson(state, { name: '測試業務' });
  state = I.recordSaleBatch(state, { customerId: state.customers[0].id, salespersonId: state.salespeople[0].id, lines: [{ itemId: state.items[0].id, quantity: 1, serialIds: [state.serials[0].id] }] });
  await storage.saveState(state);
  const next = I.recordTransaction(state, { type: 'warranty_out', warrantyId: state.warranties[0].id, itemId: state.items[0].id, quantity: 1, serialIds: [state.serials[1].id], createdBy: 'manager', note: '更換' });
  indexedDB.failNextWrite(); await assert.rejects(() => storage.saveState(next), /write failed/);
  let stored = (await storage.loadState()).state;
  assert.equal(stored.items[0].stock, 1); assert.equal(stored.serials[1].status, 'in_stock'); assert.equal(stored.transactions.length, state.transactions.length);
  await storage.saveState(I.validateState(JSON.parse(I.toBackup(next))));
  stored = (await storage.loadState()).state;
  assert.equal(stored.items[0].stock, 0); assert.equal(stored.serials[1].status, 'warranty_out');
  assert.equal(stored.transactions.at(-1).warrantyId, state.warranties[0].id); assert.equal(stored.transactions.at(-1).unitCostSnapshot, 600);
  assert.equal(stored.sales.length, 1); assert.equal(stored.warranties.length, 1);
});

test('does not overwrite malformed legacy data when migration fails', async () => {
  const { storage, legacy } = await createStorage({ legacy: '{broken' });

  await assert.rejects(storage.loadState());
  assert.equal(legacy.get('motorcycleInventory'), '{broken');
});

test('does not overwrite an empty legacy value when migration fails', async () => {
  const { storage, legacy } = await createStorage({ legacy: '' });

  await assert.rejects(storage.loadState());
  assert.equal(legacy.get('motorcycleInventory'), '');
});

test('validates writes before replacing IndexedDB state', async () => {
  const { storage, state } = await createStorage();
  await storage.saveState(state);

  await assert.rejects(storage.saveState({ items: 'invalid' }));
  assert.equal(JSON.stringify((await storage.loadState()).state), JSON.stringify(state));
});

test('keeps the stored state when an import write fails', async () => {
  const { storage, indexedDB, state } = await createStorage();
  await storage.saveState(state);
  indexedDB.failNextWrite();

  await assert.rejects(storage.saveState(stateWithItem()));
  assert.equal(JSON.stringify((await storage.loadState()).state), JSON.stringify(state));
});

function stateWithItem() {
  return {
    items: [{ id: 'item-1', name: '機油', category: '零件', sku: '', barcode: '', cost: 100, price: 200, stock: 2, minimumStock: 1, notes: '' }],
    transactions: [], customers: [], salespeople: [], quotations: [], sales: [],
  };
}

test('persists suppliers receipts payment and transaction links and keeps draft on failed receipt write', async () => {
  const { storage, indexedDB, inventory: I } = await createStorage();
  let state = I.addSupplier(I.emptyState(), { name: '供應商', taxId: '12345678' });
  const supplierId = state.suppliers[0].id;
  state = I.addItem(state, { name: '電池', category: '電池', voltage: 72, capacity: 35, supplierId, cost: 100, price: 200, stock: 0, minimumStock: 1 });
  state = I.createPurchase(state, { supplierId, lines: [{ itemId: state.items[0].id, quantity: 2, unitCost: 99.99 }], createdBy: 'manager' });
  await storage.saveState(state);
  const pid = state.purchases[0].id;
  const received = I.receivePurchase(state, pid, { receivedBy: 'receiver', serialNumbersByItem: { [state.items[0].id]: ['000A', 'B'] } });
  indexedDB.failNextWrite();
  await assert.rejects(storage.saveState(received), /write failed/);
  assert.equal(JSON.stringify((await storage.loadState()).state), JSON.stringify(state));
  await storage.saveState(received);
  const paid = I.markPurchasePaid((await storage.loadState()).state, pid, { paidBy: 'payer' });
  await storage.saveState(paid);
  const loaded = (await storage.loadState()).state;
  assert.equal(loaded.items[0].supplierId, supplierId);
  assert.equal(loaded.items[0].stock, 2);
  assert.equal(loaded.items[0].cost, 99.99);
  assert.equal(loaded.purchases[0].paidBy, 'payer');
  assert.equal(loaded.transactions[0].purchaseId, pid);
  assert.equal(JSON.stringify(I.validateState(JSON.parse(I.toBackup(loaded)))), JSON.stringify(paid));
  await assert.rejects(storage.saveState({ ...paid, purchases: {} }));
  assert.equal(JSON.stringify((await storage.loadState()).state), JSON.stringify(paid));
});
