import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// 車種：每個品項指定一個車種（「通用」＝全部車款都能用），店長維護車種清單。
const context = { window: {}, crypto: globalThis.crypto, TextDecoder, document: { getElementById: () => null } };
vm.createContext(context);
vm.runInContext(await readFile(new URL('./inventory.js', import.meta.url), 'utf8'), context);
vm.runInContext(await readFile(new URL('./item-import.js', import.meta.url), 'utf8'), context);
const { Inventory, ItemImport } = context.window;
const plain = value => JSON.parse(JSON.stringify(value));
const at = '2026-10-29T00:00:00.000Z';
const model = (id, name, extra = {}) => ({ id, name, isUniversal: false, active: true, createdAt: at, updatedAt: at, ...extra });
const base = () => Inventory.validateState({ ...Inventory.emptyState(), vehicleModels: [
  model('vm-all', '通用', { isUniversal: true }), model('vm-vespa', 'Vespa'), model('vm-old', '舊款', { active: false }),
] });
const fields = (extra = {}) => ({ name: '後照鏡', category: '外觀元件', cost: 100, price: 200, stock: 1, minimumStock: 0, ...extra });

test('new items must pick an active vehicle model once the model list is loaded', () => {
  const state = base();
  assert.throws(() => Inventory.addItem(state, fields()), /請選擇車種/);
  assert.throws(() => Inventory.addItem(state, fields({ vehicleModelId: 'vm-old' })), /不能指定已停用的車種/);
  assert.throws(() => Inventory.addItem(state, fields({ vehicleModelId: 'nope' })), /車種不存在/);
  const next = Inventory.addItem(state, fields({ vehicleModelId: 'vm-vespa' }));
  assert.equal(next.items[0].vehicleModelId, 'vm-vespa');
  assert.equal(Inventory.vehicleModelName(next, 'vm-vespa'), 'Vespa');
  // 沒有車種清單（舊版離線資料）時不檢查，維持原本行為。
  assert.equal(Inventory.addItem(Inventory.emptyState(), fields()).items.length, 1);
});

test('editing keeps an inactive model but cannot switch to one, and legacy items must pick a model', () => {
  const legacy = Inventory.validateState({ ...base(), items: [
    { id: 'i-old', name: '舊品', category: '外觀元件', sku: 'A', barcode: '', cost: 1, price: 2, stock: 0, minimumStock: 0, vehicleModelId: 'vm-old' },
    { id: 'i-none', name: '未設定', category: '外觀元件', sku: 'B', barcode: '', cost: 1, price: 2, stock: 0, minimumStock: 0 },
  ] });
  const keep = Inventory.updateItem(legacy, 'i-old', fields({ name: '舊品改名', vehicleModelId: 'vm-old', stock: 0 }));
  assert.equal(keep.items[0].vehicleModelId, 'vm-old');
  assert.throws(() => Inventory.updateItem(legacy, 'i-none', fields({ stock: 0 })), /請選擇車種/);
  assert.throws(() => Inventory.updateItem(legacy, 'i-none', fields({ stock: 0, vehicleModelId: 'vm-old' })), /不能指定已停用的車種/);
  assert.equal(Inventory.updateItem(legacy, 'i-none', fields({ stock: 0, vehicleModelId: 'vm-all' })).items[1].vehicleModelId, 'vm-all');
  assert.throws(() => Inventory.validateState({ ...legacy, items: [{ ...legacy.items[0], vehicleModelId: 'ghost' }] }), /品項車種不存在/);
});

test('vehicle model list: unique names ignoring case, universal is protected, models are deactivated not deleted', () => {
  const state = base();
  const added = Inventory.addVehicleModel(state, { name: '  小偉士 ' });
  assert.equal(added.vehicleModels.at(-1).name, '小偉士');
  assert.equal(added.vehicleModels.at(-1).active, true);
  assert.throws(() => Inventory.addVehicleModel(state, { name: 'vespa' }), /車種「vespa」已存在/);
  assert.throws(() => Inventory.addVehicleModel(state, { name: ' ' }), /車種名稱不可空白/);
  assert.throws(() => Inventory.addVehicleModel(state, { name: '字'.repeat(31) }), /最多 30 字/);
  assert.throws(() => Inventory.updateVehicleModel(state, 'vm-all', { name: '全部' }), /「通用」車種不能改名或停用/);
  assert.throws(() => Inventory.updateVehicleModel(state, 'vm-all', { active: false }), /「通用」車種不能改名或停用/);
  assert.throws(() => Inventory.updateVehicleModel(state, 'vm-vespa', { name: '舊款' }), /車種「舊款」已存在/);
  const renamed = Inventory.updateVehicleModel(state, 'vm-vespa', { name: 'Vespa GTS' });
  assert.equal(renamed.vehicleModels.find(entry => entry.id === 'vm-vespa').name, 'Vespa GTS');
  const off = Inventory.updateVehicleModel(state, 'vm-vespa', { active: false });
  assert.equal(off.vehicleModels.find(entry => entry.id === 'vm-vespa').active, false);
  assert.equal(off.vehicleModels.length, 3);
});

test('CSV import requires the vehicle model column and matches active model names ignoring case', () => {
  const state = base();
  const header = '品項名稱*,分類*,車種*,料號,成本,售價';
  const ok = ItemImport.buildPreview(state, [header, '後照鏡,外觀元件,vespa,,100,200', '手套,外觀元件,通用,,50,100'].join('\n'), { inventory: Inventory, markups: {} });
  assert.equal(ok.errorCount, 0);
  assert.deepEqual(plain(ok.nextState.items.map(item => item.vehicleModelId)), ['vm-vespa', 'vm-all']);
  assert.equal(ok.rows[0].vehicleModel, 'Vespa');
  const bad = ItemImport.buildPreview(state, [header, '空白,外觀元件,,,1,2', '停用,外觀元件,舊款,,1,2', '不存在,外觀元件,小偉士,,1,2'].join('\n'), { inventory: Inventory, markups: {} });
  assert.equal(bad.nextState, null);
  assert.deepEqual(plain(bad.rows.map(row => row.errors[0])), ['車種不可空白（全部車款都能用請填「通用」）',
    '找不到啟用中的車種「舊款」，請先在車種管理新增或啟用', '找不到啟用中的車種「小偉士」，請先在車種管理新增或啟用']);
  assert.match(ItemImport.buildPreview(state, '品項名稱,分類\nA,外觀元件', { inventory: Inventory, markups: {} }).fileError, /缺少欄位：車種/);
});

test('cloud data loads models with items and writes new models before the items that use them', async () => {
  const log = [];
  const builder = (table, method, value) => {
    log.push([table, method, value]);
    const result = { error: null, data: [{ id: 'x' }] };
    const chain = { eq: () => chain, select: () => chain, single: async () => result, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
    return chain;
  };
  const client = {
    rpc: async () => ({ error: null }),
    from: table => ({
      select: () => ({ order: () => ({ range: async () => ({ data: table === 'vehicle_models'
        ? [{ id: 'vm-all', name: '通用', is_universal: true, active: true, created_at: at, updated_at: at }]
        : table === 'items' ? [{ id: 'i1', name: '手套', category: '外觀元件', sku: 'S', barcode: '', price: 1, stock: 0, minimum_stock: 0, notes: '', vehicle_model_id: 'vm-all' }] : [], error: null }) }) }),
      insert: value => builder(table, 'insert', value),
      upsert: value => builder(table, 'upsert', value),
      update: value => builder(table, 'update', value),
    }),
  };
  const cloud = { window: { AppAuth: { client, requireActiveUser: async () => ({ id: 'admin', role: 'admin' }) },
    InventoryStorage: { loadState: async () => ({ state: null }), saveState: async () => {} }, Inventory } };
  vm.runInNewContext(await readFile(new URL('./cloud-data.js', import.meta.url), 'utf8'), cloud);
  const { state } = await cloud.window.AppData.loadSnapshot({ id: 'admin', role: 'admin' });
  assert.deepEqual(plain(state.vehicleModels.map(entry => [entry.name, entry.isUniversal])), [['通用', true]]);
  assert.equal(state.items[0].vehicleModelId, 'vm-all');

  log.length = 0;
  let next = Inventory.addVehicleModel(state, { name: '小偉士' });
  const newModel = next.vehicleModels.at(-1);
  next = Inventory.addItem(next, fields({ vehicleModelId: newModel.id }));
  next = Inventory.updateVehicleModel(next, 'vm-all', {});
  await cloud.window.AppData.saveSnapshot(state, next);
  const writes = log.filter(([table]) => table === 'vehicle_models' || table === 'items');
  assert.deepEqual(plain(writes.map(([table, method]) => `${table}.${method}`)), ['vehicle_models.insert', 'items.upsert']);
  assert.deepEqual(plain(writes[0][2]), { id: newModel.id, name: '小偉士', active: true });
  assert.equal(writes[1][2][0].vehicle_model_id, newModel.id);

  log.length = 0;
  await cloud.window.AppData.saveSnapshot(next, Inventory.updateVehicleModel(next, newModel.id, { active: false }));
  assert.deepEqual(plain(log.filter(([table]) => table === 'vehicle_models')), [['vehicle_models', 'update', { name: '小偉士', active: false }]]);
});

test('item form, inventory list, CSV preview and manage page expose the vehicle model', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<select id="item-vehicle-model" required><option value="">請選擇車種<\/option><\/select>/);
  assert.match(html, /<th>分類<\/th><th>車種<\/th><th>料號<\/th><th>條碼<\/th>/);
  assert.match(html, /<th>品項名稱<\/th><th>分類<\/th><th>車種<\/th><th>料號<\/th><th>成本<\/th>/);
  assert.match(html, /id="vehicle-model-form"/);
  assert.match(html, /<tbody id="vehicle-model-list"><\/tbody>/);
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /vehicleModelId: \$\('item-vehicle-model'\)\.value,/);
  assert.match(app, /item\.category, vehicleModelLabel\(item\.vehicleModelId\)\]/);
});
