'use strict';
/** Простой логгер: кольцевой буфер в памяти + файл logs/launcher.log + события для UI. */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { userDataDir } = require('./paths');

class Logger extends EventEmitter {
  constructor() {
    super();
    this.buffer = [];
    this.max = 500;
    this.file = null;
  }

  init() {
    try {
      const dir = path.join(userDataDir(), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, 'launcher.log');
      try {
        if (fs.statSync(this.file).size > 2 * 1024 * 1024) fs.renameSync(this.file, `${this.file}.old`);
      } catch (_) { /* файла ещё нет */ }
    } catch (_) {
      this.file = null;
    }
  }

  logsDir() {
    return this.file ? path.dirname(this.file) : null;
  }

  _write(level, msg) {
    const text = typeof msg === 'string' ? msg : (msg && msg.stack) || String(msg);
    const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] [${level}] ${text}`;
    this.buffer.push(line);
    if (this.buffer.length > this.max) this.buffer.shift();
    if (this.file) {
      try { fs.appendFileSync(this.file, `${line}\n`); } catch (_) { /* диск недоступен */ }
    }
    this.emit('line', line);
  }

  info(m) { this._write('INFO', m); }
  warn(m) { this._write('WARN', m); }
  error(m) { this._write('ERROR', m); }
  game(m) { this._write('GAME', m); }
  tail(n = 200) { return this.buffer.slice(-n); }
}

/** Замена секретов (токенов) на *** перед выводом в лог. */
function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets || []) {
    if (s && String(s).length >= 6) out = out.split(String(s)).join('***');
  }
  return out;
}

module.exports = new Logger();
module.exports.redact = redact;
