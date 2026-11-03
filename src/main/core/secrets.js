'use strict';
/**
 * Шифрование токенов перед записью на диск.
 * В Windows используется DPAPI через Electron safeStorage (ключ привязан к пользователю Windows).
 * Вне Electron (тесты) — base64 с префиксом plain:, чтобы формат оставался единым.
 */
function protect(text) {
  if (!text) return '';
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(String(text)).toString('base64')}`;
    }
  } catch (_) { /* не Electron */ }
  return `plain:${Buffer.from(String(text), 'utf8').toString('base64')}`;
}

function unprotect(blob) {
  if (!blob) return '';
  try {
    if (blob.startsWith('enc:')) {
      const { safeStorage } = require('electron');
      return safeStorage.decryptString(Buffer.from(blob.slice(4), 'base64'));
    }
    if (blob.startsWith('plain:')) return Buffer.from(blob.slice(6), 'base64').toString('utf8');
  } catch (_) { /* повреждено или другой пользователь Windows */ }
  return '';
}

module.exports = { protect, unprotect };
