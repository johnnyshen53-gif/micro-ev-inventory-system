# 離線微型機車店庫存系統 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-computer, browser-only inventory system for a micro motorcycle shop, with persistent local data and JSON backup.

**Architecture:** Keep inventory rules in a small dependency-free ES module so they can be tested with Node's built-in test runner. `app.js` owns DOM rendering, dialog/form events, and `localStorage`; `index.html` and `style.css` provide one accessible, responsive screen.

**Tech Stack:** HTML, CSS, browser JavaScript (ES modules), `localStorage`, Node.js built-in `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-09-offline-motorcycle-inventory-design.md`

## Global Constraints

- Work offline: no server, account, external package, CDN, or build step.
- Store the complete data object under the `motorcycleInventory` `localStorage` key.
- Categories are exactly `機車`, `零件`, and `用品`; transaction types are `in`, `out`, and `adjust`.
- Validate untrusted import data before it replaces saved data.
- Put every essential action behind keyboard-accessible labelled controls; do not communicate errors with colour alone.
- This directory is not currently a Git repository; do not attempt the commit steps until one exists.

## Review Focus

- Blank or whitespace-only item name: reject it without altering saved data (Task 1 test).
- Sale quantity above current stock: reject it and leave stock unchanged (Task 1 test).
- `adjust` transaction: set stock to the given number, rather than adding it (Task 1 test).
- Corrupt or incomplete backup JSON: reject it before any call to `localStorage.setItem` (Task 1 test; Task 3 manual verification).
- Browser storage quota/security error: show a save failure message and leave the UI state truthful (Task 3 manual verification).

---

## File Structure

- `index.html`: semantic shell, navigation, live status area, item and transaction forms, import/export controls.
- `style.css`: compact responsive layout, visible focus states, status/error styles.
- `inventory.js`: pure validation, item mutation, transaction mutation, import validation, and export serialization.
- `inventory.test.js`: Node tests for all inventory rules and backup validation.
- `app.js`: load/save state, render dashboard/tables, wire controls to `inventory.js`.

### Task 1: Inventory domain module

**Files:**
- Create: `inventory.js`
- Create: `inventory.test.js`

**Interfaces:**
- Produces: `emptyState()`, `validateState(value)`, `addItem(state, fields)`, `updateItem(state, id, fields)`, `deleteItem(state, id)`, `recordTransaction(state, fields)`, and `toBackup(state)`.
- Consumes: plain `{ items, transactions }` state; all mutators return a new valid state or throw `Error` with user-displayable text.

- [ ] **Step 1: Write failing Node tests for the rules**

Use `node:test` and `node:assert/strict`. Cover a valid new item, whitespace name rejection, invalid category/negative number rejection, stock changes for `in`, `out`, and `adjust`, no stock mutation on oversell, item deletion removing its transactions, and invalid backup rejection.

- [ ] **Step 2: Run the domain test suite and verify it fails**

Run: `node --test inventory.test.js`

Expected: FAIL because `inventory.js` does not exist.

- [ ] **Step 3: Implement the exact exports in `inventory.js`**

Use `crypto.randomUUID()` for IDs. Normalize numeric input with `Number`, reject non-finite values and negatives, trim item names and optional text, and clone state instead of mutating the input. `recordTransaction(state, { itemId, type, quantity, note })` decreases stock only for `out`; it must reject an out transaction that exceeds stock. `adjust` sets stock to `quantity`.

- [ ] **Step 4: Run the domain test suite and verify it passes**

Run: `node --test inventory.test.js`

Expected: PASS with all cases green.

- [ ] **Step 5: Commit the completed domain module when Git is initialized**

```bash
git add inventory.js inventory.test.js
git commit -m "feat: add inventory domain rules"
```

### Task 2: Offline accessible user interface

**Files:**
- Create: `index.html`
- Create: `style.css`

**Interfaces:**
- Consumes: `app.js` as a module script, with elements identified by stable IDs.
- Produces: a screen with dashboard, inventory, transaction, and backup sections that `app.js` can render into.

- [ ] **Step 1: Create the semantic page shell**

Add labelled controls and stable targets: `#status`, `#item-form`, `#item-id`, `#item-name`, `#item-category`, `#item-sku`, `#item-cost`, `#item-price`, `#item-stock`, `#item-minimum-stock`, `#item-notes`, `#item-search`, `#item-list`, `#transaction-form`, `#transaction-item`, `#transaction-type`, `#transaction-quantity`, `#transaction-note`, `#low-stock-list`, `#recent-transactions`, `#export-button`, and `#import-file`. Include an on-page warning that browser data should be backed up.

- [ ] **Step 2: Add responsive and accessible styles in `style.css`**

Use a readable single-column mobile layout that expands into dashboard cards and tables on wider screens. Provide clear focus rings, high contrast text, table overflow handling, and styles for inline errors and the ARIA live status region.

- [ ] **Step 3: Manually verify keyboard and responsive baseline**

Open `index.html` in a browser. Tab through every control, confirm each form input has a visible label and focus indicator, and narrow the page to verify controls remain reachable.

- [ ] **Step 4: Commit the UI shell when Git is initialized**

```bash
git add index.html style.css
git commit -m "feat: add offline inventory interface"
```

### Task 3: Browser integration and backup

**Files:**
- Create: `app.js`
- Modify: `index.html` to reference `app.js` with `type="module"`

**Interfaces:**
- Consumes: all exports from `inventory.js` and element IDs from Task 2.
- Produces: persistent data under `motorcycleInventory`, rendered dashboard/table/transaction history, and functioning backup controls.

- [ ] **Step 1: Load and save state safely**

Implement `loadState()` to return `emptyState()` when storage is empty and show an actionable warning without overwriting a malformed saved value. Implement `saveState(nextState)` to validate first, write only once, and return a boolean; catch storage exceptions and write a plain-language error into `#status`.

- [ ] **Step 2: Render current data**

Implement `render()` to update totals, low-stock list (`stock <= minimumStock`), the ten newest transaction rows, item table, and transaction item selector. Search item rows by name, SKU, or category. Show a no-results message where lists are empty.

- [ ] **Step 3: Wire item and transaction forms**

On item submit, call `addItem` or `updateItem` according to `#item-id`; on delete, call `confirm()` before `deleteItem`. On transaction submit, call `recordTransaction`. For every successful change, call `saveState`, then `render`; for every thrown validation error, preserve the form and announce the message in `#status`.

- [ ] **Step 4: Wire export and guarded import**

Export `toBackup(state)` through a Blob download named `motorcycle-inventory-backup.json`. For import, parse the selected JSON, call `validateState`, display an error on parse/validation failure, and ask for confirmation before `saveState(importedState)` replaces current state. Cancellation must leave state untouched.

- [ ] **Step 5: Execute automated and manual checks**

Run: `node --test inventory.test.js`

Expected: PASS.

Then manually verify: add a low-stock item; record an `in`, an `out`, and an `adjust`; confirm overselling is rejected; reload to prove persistence; export, edit nothing, and re-import the backup; attempt to import malformed JSON and confirm existing data remains.

- [ ] **Step 6: Commit the integration when Git is initialized**

```bash
git add app.js index.html
git commit -m "feat: persist and back up inventory"
```

### Task 4: Final regression and delivery check

**Files:**
- Verify: `index.html`, `style.css`, `inventory.js`, `inventory.test.js`, `app.js`

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: a locally usable inventory page with the specified primary flows verified.

- [ ] **Step 1: Run the full automated suite**

Run: `node --test inventory.test.js`

Expected: PASS.

- [ ] **Step 2: Run the delivery smoke test**

Open `index.html` from disk in the intended browser and repeat the Task 3 manual checks. Confirm the page makes no network requests and all required controls are available offline.

- [ ] **Step 3: Inspect changed files before handoff**

Run: `git diff --check` when Git is initialized; otherwise inspect the five created files for accidental credentials, external URLs, and broken relative paths.

- [ ] **Step 4: Commit final polish when Git is initialized**

```bash
git add index.html style.css inventory.js inventory.test.js app.js
git commit -m "feat: finish offline inventory system"
```
