'use strict';
/**
 * Discord Rich Presence по локальному IPC (named pipe \\?\pipe\discord-ipc-0..9 на Windows, сокет на Linux/macOS).
 * Без зависимостей. Любые сбои (Discord не запущен, закрыт и т.п.) молча игнорируются: статус — приятное дополнение, не функция.
 * Application ID не секретный.
 */
const net = require('net');
const os = require('os');
const path = require('path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RETRY_MS = 15000;

function defaultPipes() {
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const dirs = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp'].filter(Boolean);
  const out = [];
  for (const d of dirs) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
  return out;
}

const encode = (op, obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

class DiscordPresence {
  constructor({ clientId, pipes } = {}) {
    this.clientId = String(clientId || '');
    this.pipes = pipes || defaultPipes();
    this.sock = null;
    this.ready = false;
    this.lastTry = 0;
    this.pending = null; // последняя желаемая активность (применится при подключении)
    this.buf = Buffer.alloc(0);
  }

  _tryPipe(p) {
    return new Promise((resolve) => {
      const sock = net.connect(p);
      let settled = false;
      const done = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok ? sock : null); if (!ok) sock.destroy(); };
      const timer = setTimeout(() => done(false), 1500);
      sock.once('error', () => done(false));
      sock.once('connect', () => {
        this.buf = Buffer.alloc(0);
        sock.on('data', (d) => {
          this.buf = Buffer.concat([this.buf, d]);
          while (this.buf.length >= 8) {
            const op = this.buf.readUInt32LE(0); const len = this.buf.readUInt32LE(4);
            if (len > 1024 * 1024) { sock.destroy(); return; }
            if (this.buf.length < 8 + len) break;
            let msg = null;
            try { msg = JSON.parse(this.buf.toString('utf8', 8, 8 + len)); } catch (_) { /* не JSON */ }
            this.buf = this.buf.subarray(8 + len);
            if (op === OP.PING) sock.write(encode(OP.PONG, msg || {}));
            else if (op === OP.CLOSE) sock.destroy();
            else if (op === OP.FRAME && msg && msg.evt === 'READY') { this.sock = sock; this.ready = true; done(true); this._flush(); }
          }
        });
        sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
      });
      sock.once('close', () => { this.ready = false; if (this.sock === sock) this.sock = null; done(false); });
      sock.on('error', () => { /* после подключения тоже молча */ });
    });
  }

  async connect() {
    if (this.ready && this.sock) return true;
    if (!/^\d{15,22}$/.test(this.clientId)) return false;
    if (Date.now() - this.lastTry < RETRY_MS) return false;
    this.lastTry = Date.now();
    for (const p of this.pipes) {
      const sock = await this._tryPipe(p);
      if (sock) { this.sock = sock; return true; }
    }
    return false;
  }

  _send(activity) {
    if (!this.ready || !this.sock) return;
    const frame = { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: activity || null }, nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
    try { this.sock.write(encode(OP.FRAME, frame)); } catch (_) { /* канал закрыт */ }
  }

  _flush() { this._send(this.pending); }

  /** Показать активность: { details, state, startedAt (мс) }. null — убрать статус. */
  async set(activity) {
    this.pending = activity ? {
      details: String(activity.details || '').slice(0, 120) || undefined,
      state: String(activity.state || '').slice(0, 120) || undefined,
      timestamps: activity.startedAt ? { start: Math.floor(activity.startedAt / 1000) } : undefined,
      assets: { large_image: 'logo', large_text: 'EWLLauncher' },
    } : null;
    if (this.ready) { this._flush(); return true; }
    return this.connect();
  }

  clear() { return this.set(null); }

  close() {
    try { if (this.sock) { this.sock.write(encode(OP.CLOSE, {})); this.sock.destroy(); } } catch (_) { /* уже закрыт */ }
    this.sock = null; this.ready = false;
  }
}

module.exports = { DiscordPresence, encode, OP, defaultPipes, hostname: os.hostname };
