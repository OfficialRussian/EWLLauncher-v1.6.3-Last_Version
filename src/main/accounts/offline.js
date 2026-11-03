'use strict';
/** Офлайн-аккаунты: проверка ника и UUID, совпадающий с тем, что генерирует сам Minecraft (OfflinePlayer:<ник>). */
const crypto = require('crypto');

function validateName(name) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(n)) {
    throw new Error('Ник: от 3 до 16 символов, только латиница, цифры и «_».');
  }
  return n;
}

/** UUID v3 от "OfflinePlayer:<name>", без дефисов. */
function offlineUuid(name) {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return h.toString('hex');
}

module.exports = { validateName, offlineUuid };
