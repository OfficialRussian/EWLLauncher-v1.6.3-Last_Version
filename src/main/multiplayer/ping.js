'use strict';
/** Server List Ping (Minecraft Java 1.7+): рукопожатие + запрос статуса. Возвращает онлайн, максимум, MOTD, версию, задержку. */
const net = require('net');

const varint = (n) => {
  const out = [];
  let v = n >>> 0;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
};
const packet = (id, payload = Buffer.alloc(0)) => {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
};
function readVarint(buf, pos = 0) {
  let result = 0;
  for (let i = 0; i < 5; i++) {
    if (pos + i >= buf.length) return null;
    const b = buf[pos + i];
    result |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return { value: result >>> 0, size: i + 1 };
  }
  throw new Error('Некорректный ответ сервера');
}

/** Текст MOTD бывает строкой или деревом компонентов {text, extra[]}. */
function flatten(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(flatten).join('');
  return String(c.text || '') + (c.extra ? c.extra.map(flatten).join('') : '');
}
const stripColors = (s) => String(s).replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim();

function validHost(host) {
  return typeof host === 'string' && /^[A-Za-z0-9._-]{1,253}$/.test(host);
}

function ping({ host, port = 25565, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) { resolve({ online: false, error: 'Некорректный адрес' }); return; }
    const started = Date.now();
    let done = false;
    let buf = Buffer.alloc(0);
    const sock = net.connect({ host, port });
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve(r); };
    sock.setTimeout(timeoutMs, () => finish({ online: false, error: 'Нет ответа' }));
    sock.on('error', (e) => finish({ online: false, error: e.code === 'ENOTFOUND' ? 'Адрес не найден' : e.code === 'ECONNREFUSED' ? 'Сервер выключен' : 'Нет ответа' }));
    sock.on('connect', () => {
      // адрес — строка с длиной-varint; protocol 765 (1.20.4) подходит для запроса статуса любому серверу
      const hs = Buffer.concat([varint(765), varint(host.length), Buffer.from(host), Buffer.from([port >> 8, port & 255]), varint(1)]);
      sock.write(Buffer.concat([packet(0, hs), packet(0)]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 1024 * 1024) { finish({ online: false, error: 'Слишком большой ответ' }); return; }
      try {
        const len = readVarint(buf);
        if (!len || buf.length < len.size + len.value) return;
        const body = buf.subarray(len.size, len.size + len.value);
        const id = readVarint(body);
        if (!id || id.value !== 0) { finish({ online: false, error: 'Неожиданный ответ' }); return; }
        const sl = readVarint(body, id.size);
        const json = JSON.parse(body.toString('utf8', id.size + sl.size, id.size + sl.size + sl.value));
        finish({
          online: true,
          latency: Date.now() - started,
          players: { online: (json.players && json.players.online) || 0, max: (json.players && json.players.max) || 0 },
          version: stripColors((json.version && json.version.name) || ''),
          motd: stripColors(flatten(json.description)).slice(0, 200),
        });
      } catch (_) { finish({ online: false, error: 'Непонятный ответ' }); }
    });
  });
}

module.exports = { ping, validHost, varint, packet };
