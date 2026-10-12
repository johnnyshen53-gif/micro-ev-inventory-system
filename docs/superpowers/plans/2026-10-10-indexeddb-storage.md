# IndexedDB Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely make IndexedDB the offline motorcycle shop app's sole operational data store while automatically preserving and migrating legacy `localStorage` data.

**Architecture:** Add a small browser-native `storage.js` module that owns IndexedDB opening, reads, writes and one-time legacy migration. Keep `inventory.js` business rules unchanged; make `app.js` initialise asynchronously and await persistence before any UI success state or re-render. The old `localStorage` value is only a first-run migration source and is never deleted or updated.

**Tech Stack:** Static HTML, browser-native IndexedDB, vanilla JavaScript, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-10-indexeddb-storage-design.md`

## Global Constraints

- Use database `motorcycleInventoryDB`, version `1`, object store `state`, key `current`.
- Do not add packages or cloud services.
- Preserve legacy `localStorage.motorcycleInventory` unchanged after migration.
- Validate every state read and write through `window.Inventory.validateState`.
- Do not enable app actions until IndexedDB loading finishes.
- Retain existing JSON export/import and create a protection download before import overwrites IndexedDB.
- Keep the application usable offline in one browser profile and one local folder/origin.

## Review Focus

- IndexedDB unavailable or blocked: show an actionable error and do not render an editable empty state.
- Malformed legacy JSON: leave its raw value intact and do not create an empty IndexedDB replacement.
- Existing IndexedDB state plus stale legacy data: always prefer the validated IndexedDB record.
- IndexedDB write failure during sale/import/delete: preserve in-memory and stored pre-operation data, with no success message.
- Browser reload before initial migration completes: prevent users from submitting a form until loading resolves.

---

### Task 1: Add native IndexedDB storage and migration boundary

**Files:**
- Create: `storage.js`
- Create: `storage.test.js`
- Modify: `index.html:104-105`

**Interfaces:**
- Consumes: `window.Inventory.emptyState()` and `window.Inventory.validateState(state)`.
- Produces: `window.InventoryStorage.loadState(): Promise<{ state: object, migrated: boolean }>` and `window.InventoryStorage.saveState(nextState: object): Promise<object>`.

- [ ] **Step 1: Write the failing storage tests**

Create `storage.test.js` with an in-memory IndexedDB test double and tests named:

```js
test('migrates valid legacy localStorage data once without deleting it', async () => {
  const result = await storage.loadState();
  assert.equal(result.migrated, true);
  assert.deepEqual(await readStoredStateFromTestDatabase(), legacyState);
  assert.equal(localStorage.getItem('motorcycleInventory'), legacyJson);
});

test('prefers existing IndexedDB data over localStorage', async () => {
  assert.deepEqual((await storage.loadState()).state, indexedDbState);
});

test('does not overwrite malformed legacy data when migration fails', async () => {
  await assert.rejects(storage.loadState());
  assert.equal(localStorage.getItem('motorcycleInventory'), '{broken');
});

test('validates writes before replacing IndexedDB state', async () => {
  await assert.rejects(storage.saveState(invalidState));
  assert.deepEqual(await readStoredStateFromTestDatabase(), priorState);
});
```

- [ ] **Step 2: Run the storage tests to verify they fail**

Run: `node --test storage.test.js`  
Expected: FAIL because `storage.js` and `window.InventoryStorage` do not exist.

- [ ] **Step 3: Implement `storage.js`**

Implement private `openDatabase(): Promise<IDBDatabase>`, `loadState()` and `saveState(nextState)` with the fixed database/store/key values. During `onupgradeneeded`, create only the `state` object store. `loadState` must read `current`; if absent, parse and validate legacy `localStorage.motorcycleInventory`, write it once if valid, and return `{ state, migrated: true }`; no legacy value means `{ state: emptyState(), migrated: false }`. Reject errors rather than erasing any source data. Expose only `window.InventoryStorage`; tests inspect the in-memory database test double directly.

- [ ] **Step 4: Load `storage.js` after `inventory.js` and before `app.js`**

Add a classic script tag so `window.Inventory` is available to the storage module and `window.InventoryStorage` is available to the app. Use a cache-busting version only for changed scripts.

- [ ] **Step 5: Run storage tests to verify they pass**

Run: `node --test storage.test.js`  
Expected: PASS with all migration, source-preservation, existing-data precedence, and write-validation cases green.

- [ ] **Step 6: Commit**

If the workspace becomes a Git repository, commit `storage.js`, `storage.test.js`, and `index.html` with message `feat: add IndexedDB storage migration`.

### Task 2: Make application bootstrap and persistence asynchronous

**Files:**
- Modify: `app.js:1-100, 255-500`
- Modify: `index.html:13-22`
- Modify: `navigation.test.js`

**Interfaces:**
- Consumes: `window.InventoryStorage.loadState()` and `window.InventoryStorage.saveState(nextState)` from Task 1.
- Produces: awaited application persistence; UI controls remain disabled before `loadState` resolves.

- [ ] **Step 1: Write failing static and behavioural tests**

Add tests that require `app.js` to await storage before `render()` and require every persisted event handler to await `saveState(next)`. Include assertions for the app shell loading/disabled marker and for an IndexedDB-load error message.

```js
test('loads IndexedDB before rendering interactive inventory state', async () => {
  assert.match(app, /await InventoryStorage\.loadState\(\)/);
  assert.match(app, /await saveState\(next\)/);
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `node --test navigation.test.js`  
Expected: FAIL because bootstrap and handlers are still synchronous.

- [ ] **Step 3: Replace `localStorage` access in `app.js`**

Remove the existing synchronous `loadState` and `saveState` implementations. Create `async saveState(nextState): Promise<boolean>` that awaits `InventoryStorage.saveState(nextState)`, assigns `state` only after success, and returns false after `setStatus` on failure. Wrap bottom-of-file startup in an async bootstrap that disables main controls, awaits `InventoryStorage.loadState()`, assigns the returned state, renders, displays the migration confirmation when `migrated`, then enables controls. On load failure, keep controls disabled and show an error.

- [ ] **Step 4: Await every write call site**

Convert the item form, inventory transaction, item deletion, backup import, customer create/delete/deactivate, salesperson create/deactivate, quotation submission, and sale checkout handlers to `async`; await `saveState(next)` before resetting forms, carts, rendering, or reporting success. Preserve current validation `try/catch` messages.

- [ ] **Step 5: Run focused tests to verify they pass**

Run: `node --test navigation.test.js && node --check app.js`  
Expected: PASS and exit code 0.

- [ ] **Step 6: Commit**

If Git is available, commit `app.js`, `index.html`, and `navigation.test.js` with message `feat: persist app state through IndexedDB`.

### Task 3: Protect import/export and verify full regression coverage

**Files:**
- Modify: `app.js:326-430`
- Modify: `storage.test.js`
- Modify: `navigation.test.js`

**Interfaces:**
- Consumes: awaited `saveState(imported)` from Task 2 and `toBackup(state)`.
- Produces: import safety behaviour consistent with current download backup flow.

- [ ] **Step 1: Write the failing import failure test**

Extend the storage/app test harness to simulate an IndexedDB transaction error during import. Assert that the pre-import IndexedDB state remains readable and the application does not emit the restored-success status.

```js
test('keeps the stored state when an imported backup cannot be written', async () => {
  await assert.rejects(storage.saveState(importedState));
  assert.deepEqual(await readStoredStateFromTestDatabase(), priorState);
});
```

- [ ] **Step 2: Run the focused storage tests to verify they fail**

Run: `node --test storage.test.js`  
Expected: FAIL until the test double and transaction error handling preserve the old record.

- [ ] **Step 3: Keep import safety sequencing explicit**

Ensure the import handler validates file JSON, receives confirmation, calls `downloadBackup(state, 'motorcycle-inventory-before-import')`, then awaits `saveState(imported)`. Only after successful write may it reset forms, render and say `備份已還原。`.

- [ ] **Step 4: Run all automated verification**

Run: `node --test && node --check app.js && node --check inventory.js && node --check storage.js`  
Expected: all tests pass; all syntax checks exit 0.

- [ ] **Step 5: Perform manual browser verification in Chrome**

1. Open the existing `index.html` from the established local folder and confirm the legacy records appear with one migration success message.
2. Reload and confirm the same records remain without a second migration message.
3. Add one item, one customer, one quotation, and one barcode sale; reload and confirm all remain.
4. Export, import a known valid backup, and confirm a protection backup downloads first.
5. In DevTools Application > IndexedDB, confirm `motorcycleInventoryDB/state/current` is present while the old `localStorage` key remains unchanged.

- [ ] **Step 6: Commit**

If Git is available, commit all IndexedDB transition files with message `test: verify IndexedDB persistence safety`.

## Self-Review

- Spec coverage: Tasks 1–3 cover fixed schema, automatic migration, legacy source preservation, async writes, import protection, disabled startup, all current data-change entry points, regression tests and manual browser checks.
- Step scan: every task begins red, names exact interfaces and commands, then implements and verifies one independently reviewable outcome.
- Type consistency: Task 1 defines `InventoryStorage.loadState()` and `saveState(nextState)`; Task 2 consumes both; Task 3 consumes Task 2's awaited wrapper.
- Review Focus coverage: unavailable storage and startup gating are Task 2; malformed legacy data and existing-data precedence are Task 1; write failure and import durability are Task 3.
- Proportion: the plan specifies interfaces, test names and sequencing without duplicating implementation bodies.
