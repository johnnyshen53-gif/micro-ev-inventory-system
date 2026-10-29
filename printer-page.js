// 標籤機測試頁的操作：藍牙連線、送出測試標籤、記錄結果讓店長複製回報。
(function () {
  const $ = id => document.getElementById(id);
  const SAMPLE = { name: '測試標籤 電小二微型電動車', sku: '1120261029001', barcode: '1120261029001', serialNumber: 'TEST-0001' };
  let printer = null, busy = false;
  const lines = [];

  function log(text) {
    const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    lines.push(`[${time}] ${text}`);
    $('log').textContent = lines.join('\n');
    $('log').scrollTop = $('log').scrollHeight;
  }
  function status(text, kind = '') { $('status').textContent = text; $('status').className = kind; }
  function setConnected(connected) {
    for (const id of ['print-text', 'print-image', 'feed', 'disconnect']) $(id).disabled = !connected || busy;
    $('connect-ble').disabled = busy || !window.LabelPrinter.supportsBluetooth();
  }
  function settings() {
    const number = (id, fallback) => { const v = $(id).value.trim(); return v === '' ? fallback : Number(v); };
    return { direction: Number($('direction').value), gapMm: number('gap', 2), x: number('offset-x', 0), y: number('offset-y', 0), density: number('density', null), invert: $('invert').checked };
  }

  // 畫出測試標籤，並依「黑白顛倒」顯示實際送出的點陣樣子。
  function drawPreview() {
    try {
      const canvas = window.LabelImage.drawLabel(SAMPLE);
      const ctx = $('preview').getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      if ($('invert').checked) { ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 320, 240); ctx.globalCompositeOperation = 'source-over'; }
      return canvas;
    } catch (error) { log(`預覽失敗：${error.message}`); return null; }
  }

  async function connect(kind) {
    if (busy) return;
    busy = true; setConnected(false);
    try {
      if (printer) await printer.close();
      status('正在藍牙連線…');
      printer = await window.LabelPrinter.connectBluetooth();
      $('device-info').textContent = printer.info; $('device-info').hidden = false;
      status(`已用${printer.kind}連上：${printer.name}`, 'ok');
      log(`${printer.kind}連線成功\n${printer.info}`);
    } catch (error) {
      printer = null;
      if (error?.name === 'NotFoundError') { status('沒有選擇裝置（或清單裡找不到標籤機）。', 'error'); log(`${kind} 連線：未選擇裝置（${error.message}）`); }
      else { status(`連線失敗：${error.message}`, 'error'); log(`${kind} 連線失敗：${error.name || ''} ${error.message}`); }
    } finally { busy = false; setConnected(Boolean(printer)); }
  }

  async function send(label, bytes) {
    if (!printer || busy) return;
    busy = true; setConnected(true);
    $('progress').hidden = false; $('progress').value = 0;
    try {
      status(`正在送出：${label}（${bytes.length} bytes）…`);
      const started = performance.now();
      await printer.send(bytes, value => { $('progress').value = value; });
      const ms = Math.round(performance.now() - started);
      status(`已送出：${label}。請看標籤機有沒有印出來。`, 'ok');
      log(`送出 ${label}：${bytes.length} bytes，${ms} ms，設定 ${JSON.stringify(settings())}`);
    } catch (error) {
      status(`送出失敗：${error.message}`, 'error');
      log(`送出 ${label} 失敗：${error.name || ''} ${error.message}`);
    } finally { busy = false; setConnected(Boolean(printer)); $('progress').hidden = true; }
  }

  function support() {
    const ble = window.LabelPrinter.supportsBluetooth();
    $('support').textContent = ble ? '這個瀏覽器支援藍牙連線。' : '這個瀏覽器不支援藍牙連線，請改用 Chrome 或 Edge（iPhone 不支援）。';
    log(`瀏覽器：${navigator.userAgent}\n藍牙：${ble ? '支援' : '不支援'}`);
  }

  $('connect-ble').addEventListener('click', () => connect('ble'));
  $('disconnect').addEventListener('click', async () => {
    if (!printer) return;
    await printer.close(); printer = null; $('device-info').hidden = true;
    status('已中斷連線'); log('中斷連線'); setConnected(false);
  });
  $('print-text').addEventListener('click', () => {
    const s = settings();
    send('文字測試', window.LabelPrinter.buildTextJob({ gapMm: s.gapMm, direction: s.direction }));
  });
  $('print-image').addEventListener('click', () => {
    const canvas = drawPreview();
    if (!canvas) return;
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    send('圖片標籤', window.LabelPrinter.buildBitmapJob(image.data, canvas.width, canvas.height, { ...settings(), copies: 1 }));
  });
  $('feed').addEventListener('click', () => send('進一張紙', window.LabelPrinter.FEED_JOB));
  $('invert').addEventListener('change', drawPreview);
  $('copy').addEventListener('click', async () => {
    const text = $('log').textContent;
    try { await navigator.clipboard.writeText(text); status('測試結果已複製，可以貼給 Claude。', 'ok'); }
    catch { status('無法自動複製，請手動選取下方文字複製。', 'error'); }
  });

  support();
  drawPreview();
  setConnected(false);
})();
