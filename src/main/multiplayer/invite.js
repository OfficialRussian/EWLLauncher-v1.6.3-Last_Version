'use strict';
/**
 * Код приглашения (EWL1-...): сжатый JSON с адресами хозяина, версией и сроком действия
 * + контрольная сумма (защита от опечаток и порчи при копировании).
 * В коде НЕТ паролей и токенов — только публичный адрес. Защита самого входа — whitelist/online-mode сервера.
 */
const zlib = require('zlib');
const crypto = require('crypto');
const net = require('net');

const PREFIX = 'EWL1-';

class InviteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InviteError';
    this.code = code;
  }
}

const toB64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function parseAddress(str) {
  const m = /^\[([0-9a-fA-F:]+)\]:(\d{1,5})$/.exec(str) || /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(str);
  if (!m) return null;
  const host = m[1];
  const port = Number(m[2]);
  if (port < 1 || port > 65535 || net.isIP(host) === 0) return null;
  return { host, port };
}

const formatAddress = ({ host, port }) => (net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`);

/** addrs: [{host, port}], name: ник/имя хозяина, version: id версии Minecraft (необязательно). */
function encode({ addrs, name, version, expiresAt }) {
  const payload = {
    v: 1,
    a: addrs.map(formatAddress),
    n: String(name || '').slice(0, 32),
    m: String(version || '').slice(0, 100),
    e: Math.floor(expiresAt / 1000),
  };
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const sum = crypto.createHash('sha256').update(json).digest().subarray(0, 3);
  return PREFIX + toB64u(zlib.deflateRawSync(Buffer.concat([sum, json])));
}

function decode(code, now = Date.now()) {
  const raw = String(code || '').trim().replace(/\s+/g, '');
  if (!raw.startsWith(PREFIX)) {
    throw new InviteError('BAD_FORMAT', 'Это не код приглашения EWLLauncher (он начинается с «EWL1-»).');
  }
  let buf;
  try {
    buf = zlib.inflateRawSync(fromB64u(raw.slice(PREFIX.length)), { maxOutputLength: 4096 });
  } catch (_) {
    throw new InviteError('BAD_FORMAT', 'Код повреждён или скопирован не полностью.');
  }
  if (buf.length < 5) throw new InviteError('BAD_FORMAT', 'Код повреждён или скопирован не полностью.');
  const json = buf.subarray(3);
  const expected = crypto.createHash('sha256').update(json).digest().subarray(0, 3);
  if (!buf.subarray(0, 3).equals(expected)) {
    throw new InviteError('BAD_CHECKSUM', 'Контрольная сумма не совпала: код изменён или скопирован с ошибкой.');
  }
  let p;
  try { p = JSON.parse(json.toString('utf8')); } catch (_) { throw new InviteError('BAD_FORMAT', 'Код повреждён.'); }
  if (!p || p.v !== 1) throw new InviteError('UNSUPPORTED', 'Код создан другой версией лаунчера. Обновите EWLLauncher.');
  if (!Array.isArray(p.a) || p.a.length < 1 || p.a.length > 4) throw new InviteError('BAD_FORMAT', 'В коде нет адресов сервера.');
  const addrs = p.a.map(parseAddress);
  if (addrs.some((a) => !a)) throw new InviteError('BAD_FORMAT', 'В коде некорректный адрес.');
  const expiresAt = Number(p.e) * 1000;
  if (!Number.isFinite(expiresAt)) throw new InviteError('BAD_FORMAT', 'В коде нет срока действия.');
  return {
    addrs,
    name: String(p.n || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').slice(0, 32),
    version: /^[A-Za-z0-9._+\- ]{0,100}$/.test(p.m || '') ? String(p.m || '') : '',
    expiresAt,
    expired: now > expiresAt,
  };
}

module.exports = { encode, decode, parseAddress, formatAddress, InviteError, PREFIX };
