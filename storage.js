(() => {
const databaseName = 'motorcycleInventoryDB';
const databaseVersion = 1;
const storeName = 'state';
const stateKey = 'current';
// 記錄快取是哪個登入帳號寫入的，避免換人登入時看到上一位的資料。
const ownerKey = 'owner';
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
  const store = transaction.objectStore(storeName);
  const [value, ownerId] = await Promise.all([requestResult(store.get(stateKey)), requestResult(store.get(ownerKey))]);
  await transactionResult(transaction);
  return { value, ownerId: typeof ownerId === 'string' ? ownerId : '' };
}

// ownerId 為 undefined 時只更新資料、不改擁有者；有值時資料與擁有者在同一個交易寫入。
async function writeStoredState(state, ownerId) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  const store = transaction.objectStore(storeName);
  // 兩個寫入同時送出，避免在等待中交易提早結束。
  const writes = [requestResult(store.put(state, stateKey))];
  if (ownerId !== undefined) writes.push(requestResult(store.put(String(ownerId), ownerKey)));
  await Promise.all(writes);
  await transactionResult(transaction);
}

async function saveState(nextState, ownerId) {
  const validState = window.Inventory.validateState(nextState);
  await writeStoredState(validState, ownerId);
  return validState;
}

async function loadState() {
  const { value: stored, ownerId } = await readStoredState();
  if (stored !== undefined) return { state: window.Inventory.validateState(stored), migrated: false, ownerId };
  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) return { state: window.Inventory.emptyState(), migrated: false };
  const state = window.Inventory.validateState(JSON.parse(legacy));
  await writeStoredState(state);
  return { state, migrated: true };
}

window.InventoryStorage = { loadState, saveState };
})();
