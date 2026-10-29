// 藍牙標籤機直接列印（TSPL 指令）：美恒通 L58B 這類支援 TSPL 的低功耗藍牙（BLE）熱感標籤機。
// 2026-10 在 Mac mini 的 Chrome 實測：藍牙＋TSPL 可以列印；USB 雖能連線，但機器不執行指令，所以只用藍牙。
// 做法和原廠 SDK（PrintfTSPLManager.m）相同：
//   1. 用 label-image.js 畫好 40×30 mm 的黑白標籤圖（320×240 點）。
//   2. 轉成 TSPL 的 BITMAP 點陣：每 8 個點合成 1 個 byte，黑點＝0、白點＝1。
//   3. 加上 SIZE（標籤尺寸）、GAP（標籤間隙）、DIRECTION（方向）、CLS（清畫布）、PRINT（列印）指令。
//   4. 透過 Web Bluetooth 分段送進標籤機（BLE 每次只能送一小段）。
// 注意：L58B 收到 GAPDETECT（自動校正）會卡住，要關機重開，所以這裡不提供校正指令。
(function () {
  const ascii = text => new TextEncoder().encode(text);

  // 把 RGBA 像素（canvas 的 getImageData().data）轉成 TSPL 點陣。
  // width 必須是 8 的倍數；threshold：亮度小於它算黑點；invert：黑白顛倒（萬一機器的黑白定義相反）。
  function toBitmapBytes(rgba, width, height, { threshold = 160, invert = false } = {}) {
    if (width % 8 !== 0) throw new Error('標籤寬度（點數）必須是 8 的倍數');
    const bytesPerRow = width / 8;
    const out = new Uint8Array(bytesPerRow * height);
    for (let y = 0; y < height; y++) {
      for (let byteX = 0; byteX < bytesPerRow; byteX++) {
        let value = 0;
        for (let bit = 0; bit < 8; bit++) {
          const i = (y * width + byteX * 8 + bit) * 4;
          const gray = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
          const black = gray < threshold;
          // TSPL：位元 1＝不印（白），0＝印（黑）。最左邊的點放在最高位元。
          if (black === invert) value |= 0x80 >> bit;
        }
        out[y * bytesPerRow + byteX] = value;
      }
    }
    return out;
  }

  function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }

  // 組出一張圖片標籤的完整 TSPL 指令。
  // options：widthMm、heightMm、gapMm、direction（0／1）、x、y（點，微調位置）、copies、density（1～15，可省略）。
  function buildBitmapJob(rgba, width, height, options = {}) {
    const { widthMm = 40, heightMm = 30, gapMm = 2, direction = 1, x = 0, y = 0, copies = 1, density = null, threshold, invert } = options;
    const bitmap = toBitmapBytes(rgba, width, height, { threshold, invert });
    const header = [
      `SIZE ${widthMm} mm,${heightMm} mm`,
      `GAP ${gapMm} mm,0 mm`,
      `DIRECTION ${direction === 0 ? 0 : 1}`,
      'REFERENCE 0,0',
      ...(density ? [`DENSITY ${density}`] : []),
      'CLS',
    ].join('\r\n') + '\r\n';
    return concat([ascii(header), ascii(`BITMAP ${x},${y},${width / 8},${height},0,`), bitmap, ascii(`\r\nPRINT 1,${copies}\r\n`)]);
  }

  // 不用圖片的簡單測試：外框＋英數字＋內建 QR Code。圖片版印不出來時，用它判斷是不是「連線」本身就有問題。
  function buildTextJob({ widthMm = 40, heightMm = 30, gapMm = 2, direction = 1 } = {}) {
    const w = widthMm * 8, h = heightMm * 8;
    return ascii([
      `SIZE ${widthMm} mm,${heightMm} mm`, `GAP ${gapMm} mm,0 mm`, `DIRECTION ${direction === 0 ? 0 : 1}`, 'REFERENCE 0,0', 'CLS',
      `BOX 4,4,${w - 4},${h - 4},3`,
      'TEXT 16,16,"3",0,1,1,"VOLT BUDDY"',
      'TEXT 16,52,"2",0,1,1,"TSPL TEST OK"',
      'QRCODE 16,90,M,4,A,0,"1120261029001"',
      'TEXT 140,110,"2",0,1,1,"40x30mm"',
      'PRINT 1,1', '',
    ].join('\r\n'));
  }

  const FEED_JOB = ascii('FORMFEED\r\n');

  // ── 藍牙（Web Bluetooth，只支援 BLE 低功耗藍牙；Chrome／Edge）──
  // 網頁必須事先列出要用的服務編號，才能存取。這些是熱感標籤機／出單機常見的「透明傳輸」服務。
  const BLE_SERVICES = [
    0xff00, 0xffe0, 0xff80, 0xfee7, 0x18f0, 0xae30, 0xae00, 0xfff0, 0xffb0, 0xff10, 0xff12,
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', '0000ff00-0000-1000-8000-00805f9b34fb',
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e', '0000af30-0000-1000-8000-00805f9b34fb',
  ];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const supportsBluetooth = () => typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);

  // 連上已選好的裝置，找出第一個可以寫入的通道。斷線後也用它重新連線（不用再跳出選擇視窗）。
  async function openBluetooth(device) {
    const server = await device.gatt.connect();
    const found = [];
    let writer = null;
    for (const service of await server.getPrimaryServices()) {
      for (const characteristic of await service.getCharacteristics()) {
        const p = characteristic.properties;
        found.push(`服務 ${service.uuid}｜特徵 ${characteristic.uuid}｜${[p.write && '寫入', p.writeWithoutResponse && '快速寫入', p.notify && '通知', p.read && '讀取'].filter(Boolean).join('、')}`);
        if (!writer && (p.writeWithoutResponse || p.write)) writer = characteristic;
      }
    }
    const info = [`名稱：${device.name || '（未提供）'}`, ...found].join('\n');
    if (!writer) { server.disconnect(); throw new Error('連上了，但找不到可以寫入的通道，這台可能不是標籤機。'); }
    return {
      kind: '藍牙', name: device.name || '藍牙裝置', device, info: info + `\n使用：${writer.uuid}`,
      isConnected: () => device.gatt.connected,
      async send(bytes, onProgress = () => {}) {
        // BLE 一次只能送一小段；快速寫入要稍微停一下，標籤機才來得及收。
        const fast = writer.properties.writeWithoutResponse;
        const chunk = fast ? 180 : 20;
        for (let offset = 0; offset < bytes.length; offset += chunk) {
          const part = bytes.slice(offset, offset + chunk);
          if (fast) { await writer.writeValueWithoutResponse(part); await sleep(8); } else await writer.writeValue(part);
          onProgress(Math.min(1, (offset + chunk) / bytes.length));
        }
      },
      async close() { try { device.gatt.disconnect(); } catch { /* 已中斷 */ } },
    };
  }

  // 跳出 Chrome 的藍牙裝置清單讓使用者選標籤機。必須在按鈕點擊後「第一個」非同步動作就呼叫（瀏覽器規定）。
  async function connectBluetooth() {
    if (!supportsBluetooth()) throw new Error('這個瀏覽器不支援藍牙連線，請用 Chrome 或 Edge（Mac、Windows 或 Android）。iPhone 不支援。');
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    return openBluetooth(device);
  }

  window.LabelPrinter = { toBitmapBytes, buildBitmapJob, buildTextJob, FEED_JOB, BLE_SERVICES, supportsBluetooth, openBluetooth, connectBluetooth };
})();
