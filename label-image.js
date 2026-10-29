// 標籤圖片：給只能用手機 App 列印的藍牙標籤機（例如美恒通 L58B）。
// 「列印 QR Code」在「標籤圖片」模式下，不開瀏覽器列印，而是畫一張 40×30 mm、203 dpi 的黑白 PNG，
// 在 Android 上直接「分享」給標籤機 App；不支援分享的瀏覽器就改成下載圖片。
// 列印方式記在這台裝置的瀏覽器裡（店裡電腦用印表機、手機用標籤圖片，各自設定）。
(function () {
  const MODE_KEY = 'label-output-mode-v1';
  const DOTS_PER_MM = 8; // 203 dpi 熱感標籤機每公釐 8 點
  const WIDTH_MM = 40, HEIGHT_MM = 30;

  function mode() {
    try { return localStorage.getItem(MODE_KEY) === 'image' ? 'image' : 'print'; } catch { return 'print'; }
  }
  function setMode(value) {
    try { localStorage.setItem(MODE_KEY, value === 'image' ? 'image' : 'print'); } catch { /* 無法儲存時沿用預設的瀏覽器列印 */ }
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
  function mountModeSelect() {
    const select = document.getElementById('label-output-mode');
    if (!select) return;
    select.value = mode();
    select.addEventListener('change', () => setMode(select.value));
  }

  window.LabelImage = { mode, setMode, wrapText, qrPayload, fileName, drawLabel, output, mountModeSelect, WIDTH_MM, HEIGHT_MM, DOTS_PER_MM };
})();
