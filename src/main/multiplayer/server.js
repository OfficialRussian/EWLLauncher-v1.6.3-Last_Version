'use strict';
/**
 * ServerManager — встроенный выделенный сервер Minecraft (официальный server.jar от Mojang).
 * Хозяин создаёт сервер в один клик; белый список и online-mode защищают вход.
 * События: 'state' {state,...}, 'log' строка, 'progress' {text,fraction}
 */
const EventEmitter = require('events');
const path = require('path');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const http = require('../core/http');
const logger = require('../core/logger');
const { gamePaths } = require('../core/paths');
const versions = require('../minecraft/versions');
const { ensureJava } = require('../minecraft/java');

/** Обновляет/добавляет ключи в server.properties, сохраняя комментарии и прочие строки. */
function updateProps(text, updates) {
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/).map((l) => {
    const m = /^([^#=\s][^=]*)=(.*)$/.exec(l);
    if (m) {
      const k = m[1].trim();
      if (Object.prototype.hasOwnProperty.call(updates, k)) { seen.add(k); return `${k}=${updates[k]}`; }
    }
    return l;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

class ServerManager extends EventEmitter {
  constructor({ settings }) {
    super();
    this.settings = settings;
    this.child = null;
    this.state = 'stopped';
    this.versionId = '';
    this.port = 0;
    this.logs = [];
    this.abort = null;
  }

  dir() { return path.join(gamePaths(this.settings.get().gameDir).servers, 'main'); }

  info() { return { state: this.state, versionId: this.versionId, port: this.port, dir: this.dir(), logs: this.logs.slice(-150) }; }

  _setState(s) { this.state = s; this.emit('state', { ...this.info(), logs: undefined }); }

  _log(line) {
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    this.emit('log', line);
  }

  cancel() { if (this.abort) this.abort.abort(); }

  async start({ versionId, port, ramMax, onlineMode, whitelist, maxPlayers, motd, eulaAccepted, owner }) {
    if (this.child || this.state === 'starting') throw new Error('Сервер уже запущен.');
    if (!eulaAccepted) throw new Error('Нужно принять лицензионное соглашение Minecraft (EULA), чтобы запустить сервер.');
    if (!versionId) throw new Error('Выберите версию сервера.');

    const settings = this.settings.get();
    const root = settings.gameDir;
    const ac = new AbortController();
    this.abort = ac;
    this.versionId = versionId;
    this.port = port;
    this._setState('starting');
    this.logs = [];

    try {
      this.emit('progress', { text: 'Получение данных версии…', fraction: 0.02 });
      const vjson = await versions.ensureVersionJson(root, versionId, { signal: ac.signal });
      const dl = vjson.downloads && vjson.downloads.server;
      if (!dl) throw new Error(`Для версии ${versionId} нет серверного файла (серверы доступны с 1.2.5).`);

      const dir = this.dir();
      await fsp.mkdir(dir, { recursive: true });
      const jar = path.join(dir, `server-${versionId}.jar`);
      if (!(await http.fileValid(jar, { size: dl.size, sha1: dl.sha1 }))) {
        this.emit('progress', { text: 'Загрузка server.jar…', fraction: 0.1 });
        await http.downloadFile(dl.url, jar, { sha1: dl.sha1, size: dl.size, signal: ac.signal });
      }
      const java = await ensureJava({
        root, version: vjson, settings, signal: ac.signal,
        onProgress: (p) => this.emit('progress', { text: p.text, fraction: 0.2 + 0.7 * p.fraction }),
      });

      await fsp.writeFile(path.join(dir, 'eula.txt'), `# Принято пользователем в EWLLauncher (https://aka.ms/MinecraftEULA)\neula=true\n`);
      const propsFile = path.join(dir, 'server.properties');
      let text = '';
      try { text = await fsp.readFile(propsFile, 'utf8'); } catch (_) { /* первый запуск */ }
      await fsp.writeFile(propsFile, updateProps(text, {
        'server-port': port,
        'online-mode': !!onlineMode,
        'white-list': !!whitelist,
        'enforce-whitelist': !!whitelist,
        'max-players': maxPlayers,
        motd: String(motd || 'EWLLauncher server').replace(/[\r\n]/g, ' '),
      }));

      this.emit('progress', { text: 'Запуск сервера…', fraction: 0.95 });
      logger.info(`Запуск сервера ${versionId} на порту ${port} (Java ${java.major}, ${java.source})`);
      const child = spawn(java.path, [`-Xmx${ramMax}M`, '-Xms256M', '-jar', jar, 'nogui'], {
        cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      let ready = false;

      const onLine = (line) => {
        this._log(line);
        if (!ready && /Done \(\d/.test(line)) {
          ready = true;
          this._setState('running');
          if (whitelist && NAME_RE.test(owner || '')) this.command(`whitelist add ${owner}`);
        }
      };
      const pipeLines = (stream) => {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (l) onLine(l);
          }
        });
      };
      pipeLines(child.stdout);
      pipeLines(child.stderr);
      child.stdin.on('error', () => {});

      child.on('error', (e) => {
        this._log(`Не удалось запустить Java: ${e.message}`);
        this.child = null;
        this._setState('stopped');
      });
      child.on('exit', (code) => {
        this.child = null;
        this._log(`Сервер остановлен (код ${code}).`);
        this._setState('stopped');
        this.emit('exit', { code, ready });
      });
      return { pid: child.pid };
    } catch (e) {
      this._setState('stopped');
      if (http.isAbort(e)) throw new Error('Запуск сервера отменён.');
      throw e;
    } finally {
      this.abort = null;
    }
  }

  /** Отправка команды в консоль сервера (одна строка). */
  command(cmd) {
    if (!this.child || !this.child.stdin.writable) throw new Error('Сервер не запущен.');
    const line = String(cmd).replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
    if (!line) return;
    this._log(`> ${line}`);
    this.child.stdin.write(`${line}\n`);
  }

  whitelistAdd(name) {
    if (!NAME_RE.test(String(name || '').trim())) throw new Error('Ник: 3–16 символов, латиница, цифры и «_».');
    this.command(`whitelist add ${String(name).trim()}`);
  }

  async stop() {
    if (!this.child) return;
    this._setState('stopping');
    const child = this.child;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try { child.stdin.write('stop\n'); } catch (_) { /* уже закрыт */ }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* */ } }, 20000);
    await exited;
    clearTimeout(timer);
  }
}

module.exports = { ServerManager, updateProps };
