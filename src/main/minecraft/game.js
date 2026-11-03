'use strict';
/**
 * GameManager — жизненный цикл игры: проверка аккаунта -> установка -> запуск процесса -> завершение.
 * События: 'progress' {text, fraction}, 'started' {pid, versionId}, 'exit' {code, signal, tail, error?}
 */
const EventEmitter = require('events');
const { spawn } = require('child_process');
const logger = require('../core/logger');
const { prepareLaunch } = require('./launch');
const crash = require('./crash');
const { describe } = require('./loaders');
const http = require('../core/http');

class GameManager extends EventEmitter {
  constructor({ settings, accounts }) {
    super();
    this.settings = settings;
    this.accounts = accounts;
    this.child = null;
    this.abort = null;
    this.versionId = null;
  }

  status() {
    return { running: !!this.child, launching: !!this.abort && !this.child, versionId: this.versionId };
  }

  cancel() {
    if (this.abort) this.abort.abort();
  }

  stop() {
    if (this.child) this.child.kill();
  }

  async launch({ versionId, accountId, quickPlay = null }) {
    if (this.child || this.abort) throw new Error('Игра уже запускается или запущена.');
    if (!versionId) throw new Error('Выберите версию Minecraft.');
    const settings = this.settings.get();
    const pc = (settings.profileConfig || {})[versionId]; // личные настройки сборки поверх общих
    if (pc) {
      if (pc.ramMax) { settings.ramMax = pc.ramMax; settings.ramMin = Math.min(settings.ramMin, pc.ramMax); }
      if (pc.jvmArgs) settings.jvmArgs = `${settings.jvmArgs} ${pc.jvmArgs}`.trim();
    }
    const ac = new AbortController();
    this.abort = ac;
    this.versionId = versionId;
    const onProgress = (p) => this.emit('progress', p);

    try {
      onProgress({ text: 'Проверка аккаунта…', fraction: 0 });
      const profile = await this.accounts.getLaunchProfile(accountId, { clientId: settings.msClientId, signal: ac.signal });
      const plan = await prepareLaunch({
        root: settings.gameDir, settings, versionId, profile, quickPlay, onProgress, signal: ac.signal,
      });

      const shown = plan.args.map((a) => (plan.secrets.includes(a) ? '***' : a));
      logger.info(`Запуск: ${plan.javaPath} (Java ${plan.javaInfo.major}, ${plan.javaInfo.source})`);
      logger.info(`Аргументы: ${shown.join(' ').slice(0, 8000)}`);

      const child = spawn(plan.javaPath, plan.args, {
        cwd: plan.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      this.lastCwd = plan.cwd;
      const startedAt = Date.now();
      const tail = [];
      const full = []; // длиннее хвоста: нужен разбору вылета
      const pushLine = (line) => {
        const clean = logger.redact(line, plan.secrets);
        logger.game(clean);
        tail.push(clean);
        if (tail.length > 80) tail.shift();
        full.push(clean);
        if (full.length > 600) full.shift();
      };
      const pipeLines = (stream) => {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (line) pushLine(line);
          }
        });
        stream.on('end', () => { if (buf.trim()) pushLine(buf.trim()); });
      };
      pipeLines(child.stdout);
      pipeLines(child.stderr);

      const ctxBase = { javaMajor: plan.javaInfo.major, ram: settings.ramMax };
      // Разбор причин вылета: лог, crash-report, hs_err. Любая ошибка разбора не должна мешать событию exit.
      const diagnose = async (code, error) => {
        try {
          const files = await crash.readCrashContext(plan.cwd, startedAt);
          let kind = null;
          try { kind = (await describe(settings.gameDir, versionId)).kind; } catch (_) { /* нет JSON */ }
          const res = crash.analyze({ ...ctxBase, lines: full, code, error, kind, crashReport: files.crashReport, hsErr: files.hsErr });
          return { ...res, crashFile: files.crashFile, versionId, kind, modsDir: plan.cwd };
        } catch (e) {
          logger.warn(`Разбор вылета не удался: ${e.message}`);
          return null;
        }
      };

      child.on('error', async (err) => {
        this.child = null;
        const error = `Не удалось запустить Java: ${err.message}`;
        this.emit('exit', { code: -1, signal: null, tail, error, analysis: await diagnose(-1, error) });
      });
      child.on('exit', async (code, signal) => {
        this.child = null;
        const ms = Date.now() - startedAt;
        logger.info(`Игра завершилась: код ${code}${signal ? `, сигнал ${signal}` : ''}, ${Math.round(ms / 1000)} с`);
        const analysis = code !== 0 && code !== null ? await diagnose(code) : null;
        if (analysis && analysis.findings.length) logger.info(`Разбор вылета: ${analysis.findings.map((f) => f.id).join(', ')}`);
        this.emit('exit', { code, signal, tail, ms, analysis });
      });

      this.emit('started', { pid: child.pid, versionId });
      return { pid: child.pid };
    } catch (e) {
      if (http.isAbort(e)) throw new Error('Запуск отменён.');
      throw e;
    } finally {
      this.abort = null;
    }
  }
}

module.exports = { GameManager };
