(() => {
const databaseName = 'motorcycleInventoryDB';
const databaseVersion = 1;
const storeName = 'state';
const stateKey = 'current';
const legacyKey = 'motorcycleInventory';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('資料庫操作失敗。'));
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('資料庫交易失敗。'));
    transaction.onabort = () => reject(transaction.error || new Error('資料庫交易已取消。'));
  });
}

async function openDatabase() {
  const request = indexedDB.open(databaseName, databaseVersion);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
  };
  return requestResult(request);
}

async function readStoredState() {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const value = await requestResult(transaction.objectStore(storeName).get(stateKey));
  await transactionResult(transaction);
  return value;
}

async function writeStoredState(state) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  await requestResult(transaction.objectStore(storeName).put(state, stateKey));
  await transactionResult(transaction);
}

async function saveState(nextState) {
  const validState = window.Inventory.validateState(nextState);
  await writeStoredState(validState);
  return validState;
}

async function loadState() {
  const stored = await readStoredState();
  if (stored !== undefined) return { state: window.Inventory.validateState(stored), migrated: false };
  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) return { state: window.Inventory.emptyState(), migrated: false };
  const state = window.Inventory.validateState(JSON.parse(legacy));
  await writeStoredState(state);
  return { state, migrated: true };
}

window.InventoryStorage = { loadState, saveState };
})();
