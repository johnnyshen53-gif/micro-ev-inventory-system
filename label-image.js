// 標籤圖片：給只能用手機 App 列印的藍牙標籤機（例如美恒通 L58B）。
// 「列印 QR Code」在「標籤圖片」模式下，不開瀏覽器列印，而是畫一張 40×30 mm、203 dpi 的黑白 PNG，
// 在 Android 上直接「分享」給標籤機 App；不支援分享的瀏覽器就改成下載圖片。
// 列印方式記在這台裝置的瀏覽器裡（店裡電腦用印表機、手機用標籤圖片，各自設定）。
// 第三種「藍牙標籤機直接列印」：用 label-printer.js 把同一張標籤圖轉成 TSPL 指令，經藍牙直接送進標籤機（Chrome／Edge）。
(function () {
  const MODE_KEY = 'label-output-mode-v1';
  const PRINTER_KEY = 'label-printer-settings-v1';
  const MODES = ['print', 'image', 'ble'];
  // L58B 實測（2026-10）：方向 1、往右 32 點（4 mm）印出來正好置中。
  const DEFAULT_PRINTER = { x: 32, y: 0, direction: 1 };
  const DOTS_PER_MM = 8; // 203 dpi 熱感標籤機每公釐 8 點
  const WIDTH_MM = 40, HEIGHT_MM = 30;

  function mode() {
    try { const value = localStorage.getItem(MODE_KEY); return MODES.includes(value) ? value : 'print'; } catch { return 'print'; }
  }
  function setMode(value) {
    try { localStorage.setItem(MODE_KEY, MODES.includes(value) ? value : 'print'); } catch { /* 無法儲存時沿用預設的瀏覽器列印 */ }
  }

  // 標籤機位置設定（每台裝置各自記住）：x、y 是點數（8 點＝1 mm），範圍 ±80；方向只有 0 或 1。
  function printerSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(PRINTER_KEY) || '{}') || {}; } catch { saved = {}; }
    const offset = (value, fallback) => Number.isInteger(value) && value >= -80 && value <= 80 ? value : fallback;
    return { x: offset(saved.x, DEFAULT_PRINTER.x), y: offset(saved.y, DEFAULT_PRINTER.y), direction: saved.direction === 0 ? 0 : 1 };
  }
  function savePrinterSettings(values) {
    const next = { ...printerSettings(), ...values };
    try { localStorage.setItem(PRINTER_KEY, JSON.stringify(next)); } catch { /* 無法儲存時本次仍使用畫面上的數值 */ }
    return printerSettings();
  }

  // 藍牙標籤機：同一個頁面只選一次。斷線（例如標籤機關機再開）時，先試著自動重連同一台，不用再跳出清單。
  let printer = null, queue = Promise.resolve();
  async function connectedPrinter() {
    const lib = window.LabelPrinter;
    if (!lib) throw new Error('標籤機元件尚未載入，請重新整理頁面。');
    if (printer?.isConnected()) return printer;
    if (printer) {
      try { printer = await lib.openBluetooth(printer.device); return printer; } catch { printer = null; }
    }
    printer = await lib.connectBluetooth();
    return printer;
  }
  // 直接列印一張標籤。必須由按鈕點擊直接呼叫：第一次連線要跳出藍牙清單（瀏覽器規定要使用者操作）。
  async function printDirect(item) {
    const job = async () => {
      const device = await connectedPrinter();
      const canvas = drawLabel(item);
      const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      await device.send(window.LabelPrinter.buildBitmapJob(image.data, canvas.width, canvas.height, printerSettings()));
      return device.name;
    };
    // 連續按很多次時排隊一張一張送，避免兩張標籤的資料混在一起。
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
  }

  // 依可用寬度把文字切成多行，最多 maxLines 行，超過的最後一行加「…」。measure(text) 回傳文字寬度。
  function wrapText(text, maxWidth, maxLines, measure) {
    const chars = Array.from(String(text ?? ''));
    const lines = [];
    let line = '';
    for (let i = 0; i < chars.length; i++) {
      const next = line + chars[i];
      if (measure(next) <= maxWidth || !line) { line = next; continue; }
      lines.push(line);
      line = chars[i];
      if (lines.length === maxLines) { line = ''; break; }
    }
    if (line) lines.push(line);
    const truncated = Array.from(lines.join('')).length < chars.length;
    const kept = lines.slice(0, maxLines);
    if (truncated && kept.length) {
      let last = kept[kept.length - 1];
      while (last && measure(last + '…') > maxWidth) last = Array.from(last).slice(0, -1).join('');
      kept[kept.length - 1] = last + '…';
    }
    return kept;
  }

  // QR 內容和「列印 QR Code」相同：有原廠序號時是「條碼|序號」，否則只有條碼，結帳掃描才認得。
  const qrPayload = item => item.serialNumber ? `${item.barcode}|${item.serialNumber}` : item.barcode;

  function drawLabel(item) {
    if (!window.qrcode) throw new Error('QR Code 元件尚未載入，請確認網路後重試。');
    const W = WIDTH_MM * DOTS_PER_MM, H = HEIGHT_MM * DOTS_PER_MM, pad = 10;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
    const font = (size, weight = 700) => `${weight} ${size}px "PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif`;

    // 上方：品名，最多兩行
    ctx.font = font(24);
    const nameLines = wrapText(item.name, W - pad * 2, 2, t => ctx.measureText(t).width);
    nameLines.forEach((line, i) => ctx.fillText(line, pad, pad + i * 28));
    const top = pad + Math.max(1, nameLines.length) * 28 + 4;

    // 左下：QR Code，每個點對齊整數像素，熱感列印才清楚
    const qr = window.qrcode(0, 'M');
    qr.addData(qrPayload(item));
    qr.make();
    const count = qr.getModuleCount();
    const box = Math.min(H - top - pad, 150);
    const cell = Math.max(1, Math.floor(box / count));
    const size = cell * count;
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) ctx.fillRect(pad + c * cell, top + r * cell, cell, cell);

    // 右下：料號、原廠序號、條碼數字
    const x = pad + size + 10, colW = W - x - pad;
    let y = top;
    const block = (label, value, size) => {
      if (!value) return;
      ctx.font = font(15, 400); ctx.fillText(label, x, y); y += 18;
      ctx.font = font(size);
      for (const line of wrapText(value, colW, 2, t => ctx.measureText(t).width)) { ctx.fillText(line, x, y); y += size + 4; }
      y += 4;
    };
    block('料號', item.sku, 17);
    block('原廠序號', item.serialNumber, 17);
    if (!item.sku && item.barcode) block('條碼', item.barcode, 17);
    // 轉成純黑白：熱感標籤機只能印黑點，灰色的字邊會被印成破碎的點，先在這裡統一處理比較清楚。
    const image = ctx.getImageData(0, 0, W, H), px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 < 160 ? 0 : 255;
      px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  const fileName = item => `標籤_${String(item.sku || item.barcode || 'item').replace(/[^\w-]/g, '')}${item.serialNumber ? '_' + String(item.serialNumber).replace(/[^\w-]/g, '') : ''}.png`;

  async function output(item) {
    const canvas = drawLabel(item);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('標籤圖片產生失敗，請再試一次。');
    const file = new File([blob], fileName(item), { type: 'image/png' });
    // Android Chrome：直接分享給標籤機 App；使用者取消分享不算錯誤。
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: item.name }); return 'shared'; }
      catch (error) { if (error?.name === 'AbortError') return 'cancelled'; }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = file.name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'downloaded';
  }

  // 「標籤列印方式」選單：放在庫存清單的搜尋框旁。
  // 選「藍牙標籤機」時才顯示位置設定。不支援藍牙的瀏覽器（Safari、iPhone）把選項停用並說明。
  function mountModeSelect() {
    const select = document.getElementById('label-output-mode');
    if (!select) return;
    const ble = select.querySelector('option[value="ble"]');
    const supported = Boolean(window.LabelPrinter?.supportsBluetooth());
    if (ble && !supported) { ble.disabled = true; ble.textContent += '（此瀏覽器不支援）'; }
    if (mode() === 'ble' && !supported) setMode('print');
    select.value = mode();
    const panel = document.getElementById('label-printer-settings');
    const fields = { x: document.getElementById('label-offset-x'), y: document.getElementById('label-offset-y'), direction: document.getElementById('label-direction') };
    const fill = () => { const s = printerSettings(); if (fields.x) fields.x.value = s.x; if (fields.y) fields.y.value = s.y; if (fields.direction) fields.direction.value = String(s.direction); };
    const sync = () => { if (panel) panel.hidden = select.value !== 'ble'; };
    fill(); sync();
    select.addEventListener('change', () => { setMode(select.value); sync(); });
    for (const [key, input] of Object.entries(fields)) {
      input?.addEventListener('change', () => {
        const value = Number(input.value);
        if (Number.isInteger(value)) savePrinterSettings({ [key]: value });
        fill();
      });
    }
  }

  window.LabelImage = { mode, setMode, printerSettings, savePrinterSettings, printDirect, wrapText, qrPayload, fileName, drawLabel, output, mountModeSelect, WIDTH_MM, HEIGHT_MM, DOTS_PER_MM, DEFAULT_PRINTER };
})();
