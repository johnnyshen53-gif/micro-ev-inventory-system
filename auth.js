(() => {
const iterations = 310000;

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value) {
  if (!/^[0-9a-f]{32,}$/i.test(value) || value.length % 2) throw new Error('密碼資料無效');
  return Uint8Array.from(value.match(/../g), (byte) => Number.parseInt(byte, 16));
}

async function passwordHash(password, salt) {
  if (!crypto?.subtle) throw new Error('此瀏覽器不支援安全密碼功能。');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations, salt }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

async function createPasswordRecord(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('密碼至少需要 8 個字元。');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: bytesToHex(salt), hash: await passwordHash(password, salt) };
}

async function verifyPassword(password, record) {
  if (typeof password !== 'string' || typeof record?.salt !== 'string' || typeof record?.hash !== 'string') return false;
  const expected = await passwordHash(password, hexToBytes(record.salt));
  return expected === record.hash;
}

window.InventoryAuth = { createPasswordRecord, verifyPassword };
})();
