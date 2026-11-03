'use strict';
/**
 * Минимальный STUN-клиент (RFC 5389): узнаёт ВНЕШНИЙ IPv4-адрес по UDP.
 * Используется только для определения адреса — никакой трафик игры через STUN/сторонние сервера не идёт.
 */
const dgram = require('dgram');
const crypto = require('crypto');

const SERVERS = [
  ['stun.l.google.com', 19302],
  ['stun1.l.google.com', 19302],
  ['stun.cloudflare.com', 3478],
];
const MAGIC = 0x2112a442;

function buildRequest() {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0); // Binding Request
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(MAGIC, 4);
  crypto.randomBytes(12).copy(b, 8);
  return b;
}

function parseResponse(buf, txId) {
  if (buf.length < 20 || buf.readUInt16BE(0) !== 0x0101) return null;
  if (buf.readUInt32BE(4) !== MAGIC || !buf.subarray(8, 20).equals(txId)) return null;
  const end = Math.min(buf.length, 20 + buf.readUInt16BE(2));
  let off = 20;
  let plain = null;
  while (off + 4 <= end) {
    const type = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    const v = off + 4;
    if ((type === 0x0020 || type === 0x0001) && len >= 8 && buf[v + 1] === 0x01) {
      if (type === 0x0020) { // XOR-MAPPED-ADDRESS
        const port = buf.readUInt16BE(v + 2) ^ (MAGIC >>> 16);
        const ip = [buf[v + 4] ^ 0x21, buf[v + 5] ^ 0x12, buf[v + 6] ^ 0xa4, buf[v + 7] ^ 0x42].join('.');
        return { ip, port };
      }
      plain = { ip: [...buf.subarray(v + 4, v + 8)].join('.'), port: buf.readUInt16BE(v + 2) };
    }
    off = v + len + ((4 - (len % 4)) % 4);
  }
  return plain;
}

function query(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const req = buildRequest();
    const txId = req.subarray(8, 20);
    const done = (err, res) => {
      clearTimeout(timer);
      try { sock.close(); } catch (_) { /* уже закрыт */ }
      if (err) reject(err); else resolve(res);
    };
    const timer = setTimeout(() => done(new Error('STUN: таймаут')), timeoutMs);
    sock.on('error', (e) => done(e));
    sock.on('message', (msg) => {
      const r = parseResponse(msg, txId);
      if (r) done(null, r);
    });
    sock.send(req, port, host, (e) => { if (e) done(e); });
  });
}

/** Внешний IPv4: { ip, port }. Бросает ошибку, если все STUN-серверы недоступны. */
async function getPublicIPv4(timeoutMs = 2500) {
  let last;
  for (const [h, p] of SERVERS) {
    try { return await query(h, p, timeoutMs); } catch (e) { last = e; }
  }
  throw last || new Error('STUN недоступен');
}

module.exports = { getPublicIPv4, parseResponse, buildRequest };
