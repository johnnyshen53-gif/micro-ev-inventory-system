// 官網商品（店長專用）：勾選哪些車身／電池顯示在官網 voltbuddys.com 的車款頁，填規格、簡介並上傳照片。
// 放在「庫存操作」頁；和品項編輯分開存（item_web），不影響庫存與銷售資料。官網不顯示價格。
(function () {
  const $ = id => document.getElementById(id);
  const WEB_CATEGORIES = ['車身', '電池'];
  const MAX_SUMMARY = 300, MAX_BATTERY = 60, MAX_PHOTO_BYTES = 2 * 1024 * 1024, PHOTO_EDGE = 1600;

  function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  // 檢查表單內容；數字欄位留空＝官網不顯示該項。回傳 { error } 或 { value }（送給資料庫的格式）。
  function normalizeWeb(itemId, fields) {
    const integer = (text, min, max, label) => {
      const value = String(text ?? '').trim();
      if (!value) return { value: null };
      if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) return { error: `${label}請填 ${min}～${max} 的整數，或留空。` };
      return { value: Number(value) };
    };
    const range = integer(fields.rangeKm, 1, 999, '續航（公里）');
    if (range.error) return range;
    const speed = integer(fields.topSpeed, 1, 99, '最高時速（公里）');
    if (speed.error) return speed;
    const batterySpec = String(fields.batterySpec ?? '').trim(), summary = String(fields.summary ?? '').trim();
    if (batterySpec.length > MAX_BATTERY) return { error: `電池規格最多 ${MAX_BATTERY} 字。` };
    if (summary.length > MAX_SUMMARY) return { error: `簡介最多 ${MAX_SUMMARY} 字。` };
    return { value: { itemId, visible: fields.visible === true, rangeKm: range.value, topSpeed: speed.value, batterySpec, summary, photoPath: fields.photoPath || null } };
  }

  // 照片檔名：「品項 id／時間戳記.副檔名」。每次換照片都用新檔名，官網和瀏覽器快取不會顯示到舊圖。
  const photoPath = (itemId, now, mime) => `${itemId}/${now}.${mime === 'image/webp' ? 'webp' : mime === 'image/png' ? 'png' : 'jpg'}`;

  function webStatus(web) {
    if (!web) return { key: 'none', label: '未設定' };
    return web.visible ? { key: 'on', label: '顯示中' } : { key: 'off', label: '未顯示' };
  }

  // 手機拍的照片常常好幾 MB：先在瀏覽器縮到長邊 1600 像素，再轉成 WebP（不支援時用 JPEG），上傳更快、官網載入也快。
  async function shrinkPhoto(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('請選擇 JPG、PNG 或 WebP 照片。');
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const encode = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
    let blob = await encode('image/webp', 0.85);
    if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg', 0.85);
    if (!blob) throw new Error('照片處理失敗，請換一張試試。');
    if (blob.size > MAX_PHOTO_BYTES) throw new Error('照片縮小後仍超過 2 MB，請換一張。');
    return blob;
  }

  function mount({ getState, notify = () => {} } = {}) {
    if (!$('web-item-form')) return { load() {}, refresh() {}, clear() {} };
    let settings = new Map(), editing = null, pendingPhoto = null, removePhoto = false, previewUrl = '', busy = false, generation = 0;
    const isAdmin = () => document.body.dataset?.role === 'admin';
    const message = (text, error = false) => { $('web-item-status').textContent = text; $('web-item-status').classList.toggle('error', error); notify(text, error); };
    const formError = text => { $('web-item-form-error').textContent = text; $('web-item-form-error').hidden = !text; };
    const items = () => (getState?.().items ?? []).filter(item => WEB_CATEGORIES.includes(item.category))
      .sort((a, b) => WEB_CATEGORIES.indexOf(a.category) - WEB_CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name, 'zh-Hant'));

    function render() {
      const body = $('web-item-list'); body.replaceChildren();
      for (const item of items()) {
        const web = settings.get(item.id), status = webStatus(web);
        const row = element('tr'), actions = element('td'); actions.className = 'actions';
        const button = element('button', '官網設定', 'secondary'); button.type = 'button'; button.dataset.webItem = item.id; actions.append(button);
        row.append(element('td', item.name), element('td', item.category), element('td', status.label, `web-state web-state-${status.key}`),
          element('td', web?.photoPath ? '有' : '—'), actions);
        body.append(row);
      }
      if (!body.children.length) {
        const row = element('tr'), cell = element('td', '還沒有車身或電池品項。', 'empty'); cell.colSpan = 5; row.append(cell); body.append(row);
      }
    }
    function setPreview(url) {
      if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
      previewUrl = url;
      $('web-item-photo-preview').hidden = !url;
      $('web-item-photo-preview').src = url || '';
      $('web-item-photo-remove').hidden = !url;
    }
    function updateCounter() { $('web-item-summary-count').textContent = `${$('web-item-summary').value.trim().length}／${MAX_SUMMARY}`; }
    function closeForm() {
      editing = null; pendingPhoto = null; removePhoto = false;
      $('web-item-form').reset(); $('web-item-form').hidden = true; formError(''); setPreview('');
    }
    function openForm(item) {
      const web = settings.get(item.id) ?? {};
      editing = item; pendingPhoto = null; removePhoto = false;
      $('web-item-form-title').textContent = `官網設定：${item.name}`;
      $('web-item-category-note').textContent = item.category === '車身' ? '官網會註明「含配件、不含電池（電池另購）」。' : '';
      $('web-item-visible').checked = web.visible === true;
      $('web-item-range').value = web.rangeKm ?? '';
      $('web-item-speed').value = web.topSpeed ?? '';
      $('web-item-battery').value = web.batterySpec ?? '';
      $('web-item-summary').value = web.summary ?? '';
      $('web-item-photo').value = '';
      setPreview(web.photoPath ? window.AppData.websitePhotoUrl(web.photoPath) : '');
      updateCounter(); formError('');
      $('web-item-form').hidden = false;
      $('web-item-form').scrollIntoView?.({ block: 'nearest' });
      $('web-item-visible').focus();
    }
    async function refresh() {
      const request = ++generation;
      const loaded = await window.AppData.loadWebsiteItems();
      if (request !== generation || window.AppAuthUI?.isActive?.() === false) return;
      settings = new Map(loaded.map(web => [web.itemId, web])); render();
    }

    $('web-item-list').addEventListener('click', event => {
      const button = event.target.closest('button[data-web-item]');
      const item = button && items().find(candidate => candidate.id === button.dataset.webItem);
      if (item) openForm(item);
    });
    $('web-item-summary').addEventListener('input', updateCounter);
    $('web-item-cancel').addEventListener('click', closeForm);
    $('web-item-photo').addEventListener('change', async () => {
      const file = $('web-item-photo').files?.[0];
      if (!file) return;
      try {
        formError('');
        pendingPhoto = await shrinkPhoto(file);
        removePhoto = false;
        setPreview(URL.createObjectURL(pendingPhoto));
      } catch (error) { pendingPhoto = null; $('web-item-photo').value = ''; formError(error.message); }
    });
    $('web-item-photo-remove').addEventListener('click', () => { pendingPhoto = null; removePhoto = true; $('web-item-photo').value = ''; setPreview(''); });

    // 儲存順序：先上傳新照片 → 再存設定 → 成功後才刪舊照片。設定存失敗就把剛上傳的照片刪掉，不留孤兒檔。
    $('web-item-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (!editing || busy || !isAdmin()) return;
      const item = editing, old = settings.get(item.id)?.photoPath || '';
      let newPath = removePhoto ? '' : old;
      const checked = normalizeWeb(item.id, { visible: $('web-item-visible').checked, rangeKm: $('web-item-range').value, topSpeed: $('web-item-speed').value,
        batterySpec: $('web-item-battery').value, summary: $('web-item-summary').value, photoPath: newPath });
      if (checked.error) return formError(checked.error);
      if (checked.value.visible && !pendingPhoto && !newPath && !window.confirm('這個品項還沒有照片，官網會顯示「照片準備中」。確定要先顯示嗎？')) return;
      busy = true; formError(''); $('web-item-save').disabled = true;
      let uploaded = '';
      try {
        if (pendingPhoto) {
          uploaded = photoPath(item.id, Date.now(), pendingPhoto.type);
          await window.AppData.uploadWebsitePhoto(uploaded, pendingPhoto);
          newPath = uploaded;
        }
        await window.AppData.saveItemWeb({ ...checked.value, photoPath: newPath || null });
        uploaded = '';
        if (old && old !== newPath) await window.AppData.deleteWebsitePhoto(old).catch(() => {});
        await refresh();
        closeForm();
        message(`「${item.name}」的官網設定已儲存${checked.value.visible ? '，官網車款頁會自動顯示' : '（目前不顯示在官網）'}。`);
      } catch (error) {
        if (uploaded) await window.AppData.deleteWebsitePhoto(uploaded).catch(() => {});
        formError(error.message);
      } finally { busy = false; $('web-item-save').disabled = false; }
    });

    return {
      async load() {
        if (!isAdmin()) return;
        try { await refresh(); } catch (error) { message(`無法讀取官網商品設定：${error.message}`, true); }
      },
      refresh() { if (isAdmin()) render(); },
      clear() { generation++; settings = new Map(); closeForm(); $('web-item-list').replaceChildren(); $('web-item-status').textContent = ''; },
    };
  }
  window.WebsiteItemsUI = { mount, normalizeWeb, photoPath, webStatus, WEB_CATEGORIES };
})();
