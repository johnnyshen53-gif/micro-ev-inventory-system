// 用平板／手機的相機掃 QR Code（Android Chrome 內建的 BarcodeDetector，不用另外載入程式）。
// 流程：按「相機掃描」→ 跳出相機畫面 → 每 0.25 秒辨識一次 → 掃到就關閉相機，把內容交給原本的掃描處理（和掃描槍輸入相同）。
// 瀏覽器不支援（例如 iPad／iPhone 的 Safari）時，按鈕不會出現，繼續用掃描槍或手動輸入。
(function () {
  const FORMATS = ['qr_code', 'code_128', 'ean_13'];
  let stream = null, timer = null, busy = false, dialog = null;

  const supported = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

  // 相機畫面（第一次用到時才建立）：影像、提示文字、取消按鈕。
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'camera-scan-dialog';
    dialog.setAttribute('aria-label', '相機掃描 QR Code');
    const video = document.createElement('video');
    video.setAttribute('playsinline', ''); video.muted = true;
    const hint = document.createElement('p'); hint.className = 'camera-scan-hint'; hint.textContent = '把 QR Code 對準框內，掃到會自動關閉。';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = '取消';
    cancel.addEventListener('click', stop);
    dialog.addEventListener('cancel', stop);
    dialog.append(video, hint, cancel);
    document.body.append(dialog);
    return dialog;
  }

  // 關閉相機（掃到、取消、按 Esc 都會呼叫）：停止辨識、關掉鏡頭，避免一直耗電。
  function stop() {
    clearInterval(timer); timer = null; busy = false;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    if (dialog?.open) dialog.close();
  }

  async function open(onResult) {
    if (!supported()) throw new Error('這台裝置的瀏覽器不支援相機掃描，請用 Android 的 Chrome。');
    const available = await window.BarcodeDetector.getSupportedFormats?.() ?? FORMATS;
    const formats = FORMATS.filter(format => available.includes(format));
    if (!formats.includes('qr_code')) throw new Error('這台裝置的瀏覽器不支援辨識 QR Code。');
    const detector = new window.BarcodeDetector({ formats });
    const box = ensureDialog(), video = box.querySelector('video');
    try {
      // 優先用後鏡頭（environment）。
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (error) {
      throw new Error(error?.name === 'NotAllowedError' ? '沒有相機權限：請在瀏覽器網址列左邊的設定允許使用相機。' : `無法開啟相機：${error?.message || error}`);
    }
    video.srcObject = stream;
    box.showModal();
    await video.play().catch(() => {});
    timer = setInterval(async () => {
      if (busy || !stream) return;
      busy = true;
      try {
        const codes = await detector.detect(video);
        const value = codes.find(code => code.rawValue)?.rawValue;
        if (value) { stop(); navigator.vibrate?.(60); onResult(value); }
      } catch { /* 畫面還沒準備好，下一輪再試 */ } finally { busy = false; }
    }, 250);
  }

  // 把按鈕接上相機掃描；不支援的瀏覽器就保持隱藏。onError 用來在表單上顯示錯誤訊息。
  function mount(button, onResult, onError = () => {}) {
    if (!button) return;
    button.hidden = !supported();
    button.addEventListener('click', async () => {
      try { await open(onResult); } catch (error) { stop(); onError(error.message); }
    });
  }

  window.CameraScan = { supported, open, stop, mount };
})();
