'use strict';
/**
 * Проверка доступности Minecraft-сервера по протоколу Server List Ping (TCP).
 * Возвращает версию, онлайн, MOTD и задержку — или понятную ошибку.
 */
const net = require('net');

function writeVarInt(value) {
  let n = value;
  const out = [];
  do {
    let t = n & 0x7f;
    n >>>= 7;
    if (n !== 0) t |= 0x80;
    out.push(t);
  } while (n !== 0);
  return Buffer.from(out);
}

function readVarInt(buf, off = 0) {
  let num = 0;
  let shift = 0;
  let pos = off;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    num |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 35) throw new Error('VarInt слишком длинный');
  }
  return { value: num, size: pos - off };
}

const mcString = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
};
const packet = (id, payload) => {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
};

function flattenText(d) {
  if (typeof d === 'string') return d.replace(/§./g, '');
  if (!d || typeof d !== 'object') return '';
  let s = d.text || '';
  if (Array.isArray(d.extra)) s += d.extra.map(flattenText).join('');
  return s.replace(/§./g, '');
}

class ProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
  }
}

/** Понятное объяснение ошибки для пользователя. */
function describeProbeError(err) {
  const code = (err && err.code) || 'UNKNOWN';
  const map = {
    ECONNREFUSED: ['Сервер отклонил подключение', 'Сервер не запущен, указан неверный порт, либо порт не проброшен на роутере.'],
    ETIMEDOUT: ['Нет ответа от сервера', 'Порт закрыт брандмауэром/роутером, адрес устарел или у хозяина нет белого IP.'],
    EHOSTUNREACH: ['Узел недоступен', 'Нет маршрута до адреса. Проверьте интернет и актуальность приглашения.'],
    ENETUNREACH: ['Сеть недоступна', 'Для IPv6-адреса нужен рабочий IPv6 у обоих игроков.'],
    ECONNRESET: ['Соединение разорвано сервером', 'Возможно, сервер перегружен или это не Minecraft.'],
    CLOSED: ['Сервер закрыл соединение', 'Это может быть не Minecraft-сервер или несовместимая защита.'],
    BAD_REPLY: ['Некорректный ответ', 'По этому адресу отвечает не Minecraft-сервер.'],
  };
  const [title, hint] = map[code] || ['Не удалось подключиться', (err && err.message) || 'Неизвестная ошибка'];
  return { code, title, hint };
}

function probe(host, port, { timeoutMs = 4000, protocol = -1 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let connectMs = null;
    let buf = Buffer.alloc(0);
    let status = null;
    let pingSentAt = 0;
    let done = false;
    let afterTimer = null;

    const sock = net.connect({ host, port });
    sock.setNoDelay(true);
    sock.setTimeout(timeoutMs);

    const finish = (err, res) => {
      if (done) return;
      done = true;
      clearTimeout(afterTimer);
      sock.destroy();
      if (err) reject(err); else resolve(res);
    };
    const result = (latencyMs) => ({
      ok: true,
      host,
      port,
      latencyMs,
      version: (status.version && status.version.name) || '?',
      protocol: status.version && status.version.protocol,
      players: {
        online: (status.players && status.players.online) || 0,
        max: (status.players && status.players.max) || 0,
      },
      motd: flattenText(status.description).trim().slice(0, 200),
    });

    sock.on('connect', () => {
      connectMs = Date.now() - started;
      const hs = Buffer.concat([writeVarInt(protocol), mcString(host), Buffer.from([(port >> 8) & 0xff, port & 0xff]), writeVarInt(1)]);
      sock.write(Buffer.concat([packet(0x00, hs), packet(0x00, Buffer.alloc(0))]));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 2 * 1024 * 1024) return finish(new ProbeError('BAD_REPLY', 'Слишком большой ответ'));
      let len;
      try { len = readVarInt(buf); } catch (e) { return finish(new ProbeError('BAD_REPLY', e.message)); }
      if (!len || buf.length < len.size + len.value) return undefined;
      const pkt = buf.subarray(len.size, len.size + len.value);
      buf = buf.subarray(len.size + len.value);
      try {
        const id = readVarInt(pkt);
        if (!id) throw new Error('пустой пакет');
        if (!status) {
          if (id.value !== 0) throw new Error('неожиданный пакет');
          const sl = readVarInt(pkt, id.size);
          const json = pkt.toString('utf8', id.size + sl.size, id.size + sl.size + sl.value);
          status = JSON.parse(json);
          pingSentAt = Date.now();
          const ping = Buffer.alloc(8);
          ping.writeBigInt64BE(BigInt(pingSentAt));
          sock.write(packet(0x01, ping));
          afterTimer = setTimeout(() => finish(null, result(connectMs)), 1500);
        } else {
          finish(null, result(Date.now() - pingSentAt));
        }
      } catch (e) {
        finish(new ProbeError('BAD_REPLY', `Некорректный ответ сервера: ${e.message}`));
      }
      return undefined;
    });

    sock.on('timeout', () => finish(new ProbeError('ETIMEDOUT', 'Время ожидания истекло')));
    sock.on('error', (e) => finish(new ProbeError(e.code || 'UNKNOWN', e.message)));
    sock.on('close', () => finish(new ProbeError('CLOSED', 'Соединение закрыто')));
  });
}

module.exports = { probe, describeProbeError, ProbeError, writeVarInt, readVarInt, flattenText };
