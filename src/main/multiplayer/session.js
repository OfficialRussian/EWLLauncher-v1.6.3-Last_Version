'use strict';
/**
 * HostSession — «создание подключения» на стороне хозяина.
 * Прямое соединение без прокси и VPN: проброс порта через UPnP (или ручной проброс) +
 * публичный IPv4 и/или глобальный IPv6. Итог — код приглашения для друга.
 * События: 'step' {id,label,status,detail}, 'stopped'.
 */
const EventEmitter = require('events');
const stun = require('./stun');
const upnp = require('./upnp');
const netinfo = require('./netinfo');
const { probe } = require('./probe');
const invite = require('./invite');
const logger = require('../core/logger');

class HostError extends Error {
  constructor(code, message, steps) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.steps = steps || [];
  }
}

const randomPorts = (n) => Array.from({ length: n }, () => 20000 + Math.floor(Math.random() * 40000));

class HostSession extends EventEmitter {
  constructor() {
    super();
    this.active = null;
    this.gateway = null;
    this.mapped = null;
    this.renewTimer = null;
    this.expireTimer = null;
    this.leaseSec = 3600;
  }

  async _addMapping(gw, externalPort, internalPort, lan) {
    const args = { externalPort, internalPort, internalClient: lan, description: 'EWLLauncher' };
    try {
      await gw.addMapping({ ...args, leaseSec: this.leaseSec });
    } catch (e) {
      if (e.code === 725) { // роутер поддерживает только бессрочные записи
        this.leaseSec = 0;
        await gw.addMapping({ ...args, leaseSec: 0 });
      } else throw e;
    }
  }

  async start({ port, versionId, hostName, ttlMinutes = 240, manualForward = false }) {
    await this.stop();
    const steps = [];
    const step = (id, label, status, detail = '') => {
      const s = { id, label, status, detail };
      const i = steps.findIndex((x) => x.id === id);
      if (i >= 0) steps[i] = s; else steps.push(s);
      this.emit('step', s);
    };
    const fail = (code, message) => { throw new HostError(code, message, steps); };

    // 1. Локальный сервер
    step('local', 'Проверка вашего сервера', 'run');
    try {
      const r = await probe('127.0.0.1', port, { timeoutMs: 3000 });
      step('local', 'Проверка вашего сервера', 'ok', `${r.version}, игроков ${r.players.online}/${r.players.max}`);
    } catch (_) {
      step('local', 'Проверка вашего сервера', 'fail', `На порту ${port} нет Minecraft-сервера`);
      fail('SERVER_NOT_RUNNING', `На порту ${port} не найден работающий сервер. Запустите сервер (или откройте одиночный мир для сети и укажите его порт).`);
    }

    // 2. Внешний IP
    step('stun', 'Определение внешнего IP-адреса', 'run');
    let stunIp = null;
    try {
      stunIp = (await stun.getPublicIPv4()).ip;
      step('stun', 'Определение внешнего IP-адреса', 'ok', stunIp);
    } catch (_) {
      step('stun', 'Определение внешнего IP-адреса', 'warn', 'STUN-серверы недоступны, адрес возьмём у роутера');
    }

    // 3. Проброс порта
    let routerIp = '';
    let extPort = port;
    let mapped = false;
    if (manualForward) {
      step('upnp', 'Проброс порта (UPnP)', 'skip', 'Пропущено: вы пробросили порт на роутере вручную');
    } else {
      step('upnp', 'Проброс порта (UPnP)', 'run');
      try {
        const gw = await upnp.discoverGateway(2500);
        if (!gw) {
          step('upnp', 'Проброс порта (UPnP)', 'warn',
            `Роутер не ответил по UPnP. Включите UPnP в роутере или пробросьте TCP-порт ${port} вручную и повторите с галочкой «Порт проброшен вручную».`);
        } else {
          routerIp = await gw.getExternalIP().catch(() => '');
          const lan = await gw.localAddress();
          let lastErr = null;
          for (const ep of [port, ...randomPorts(3)]) {
            try { await this._addMapping(gw, ep, port, lan); extPort = ep; mapped = true; break; } catch (e) { lastErr = e; }
          }
          if (mapped) {
            this.gateway = gw;
            this.mapped = { externalPort: extPort, internalPort: port, lan };
            step('upnp', 'Проброс порта (UPnP)', 'ok', `Внешний порт ${extPort} → ${lan}:${port}`);
            if (this.leaseSec > 0) {
              this.renewTimer = setInterval(() => {
                this._addMapping(gw, extPort, port, lan).catch((e) => logger.warn(`UPnP: не удалось продлить проброс: ${e.message}`));
              }, 30 * 60 * 1000);
            }
          } else {
            step('upnp', 'Проброс порта (UPnP)', 'warn', `Роутер отказал в пробросе: ${lastErr ? lastErr.message : 'неизвестная ошибка'}`);
          }
        }
      } catch (e) {
        step('upnp', 'Проброс порта (UPnP)', 'warn', `Ошибка UPnP: ${e.message}`);
      }
    }

    // 4. Тип подключения (белый IP / CGNAT)
    const candidates = [];
    let publicV4 = null;
    if (routerIp && netinfo.isNonPublicV4(routerIp)) {
      step('nat', 'Тип подключения к интернету', 'warn',
        `Роутер получил от провайдера адрес ${routerIp} — «серый» IP (CGNAT). Прямое подключение по IPv4 невозможно. Используйте IPv6 или закажите у провайдера белый IP.`);
    } else {
      publicV4 = routerIp || stunIp;
      if (publicV4) step('nat', 'Тип подключения к интернету', 'ok', `Белый IPv4: ${publicV4}`);
      else step('nat', 'Тип подключения к интернету', 'warn', 'Не удалось определить внешний IPv4');
    }
    let v4 = null;
    if (publicV4) {
      v4 = { host: publicV4, port: extPort };
      candidates.push(v4);
    }

    // 5. IPv6
    const v6 = netinfo.globalIPv6()[0];
    if (v6) {
      candidates.push({ host: v6, port });
      step('ipv6', 'Прямой адрес IPv6', 'ok', `${v6} (разрешите входящий TCP ${port} в брандмауэре Windows и роутера)`);
    } else {
      step('ipv6', 'Прямой адрес IPv6', 'skip', 'Глобального IPv6 нет');
    }

    if (!candidates.length) {
      fail('NO_ROUTE', 'Не найдено ни одного адреса, по которому друг мог бы подключиться напрямую (нет белого IPv4 и IPv6).');
    }

    // 6. Самопроверка IPv4 (может не работать без NAT loopback — это не ошибка)
    if (v4) {
      step('selfcheck', 'Проверка доступности снаружи', 'run');
      try {
        await probe(v4.host, v4.port, { timeoutMs: 4000 });
        step('selfcheck', 'Проверка доступности снаружи', 'ok', 'Порт отвечает по внешнему адресу');
      } catch (_) {
        step('selfcheck', 'Проверка доступности снаружи', 'warn',
          'Из вашей сети проверить не удалось (многие роутеры не поддерживают NAT loopback). Друг проверит сам кнопкой «Проверить».');
      }
    }

    const ttl = Math.max(5, Math.min(1440, ttlMinutes));
    const expiresAt = Date.now() + ttl * 60 * 1000;
    const code = invite.encode({ addrs: candidates, name: hostName, version: versionId, expiresAt });
    this.active = { code, candidates, port, extPort, expiresAt, versionId, mapped, startedAt: Date.now() };
    this.expireTimer = setTimeout(() => this.stop().catch(() => {}), ttl * 60 * 1000);
    logger.info(`Подключение создано: ${candidates.map(invite.formatAddress).join(', ')}`);
    return { ...this.active, steps, warnings: steps.filter((s) => s.status === 'warn').map((s) => s.detail) };
  }

  status() {
    return this.active ? { ...this.active } : null;
  }

  async stop() {
    clearInterval(this.renewTimer);
    clearTimeout(this.expireTimer);
    this.renewTimer = null;
    this.expireTimer = null;
    if (this.gateway && this.mapped) {
      try { await this.gateway.deleteMapping(this.mapped.externalPort); } catch (e) { logger.warn(`UPnP: не удалось убрать проброс: ${e.message}`); }
    }
    const wasActive = !!this.active;
    this.gateway = null;
    this.mapped = null;
    this.active = null;
    if (wasActive) this.emit('stopped');
  }

  /** Быстрая диагностика сети без создания подключения. */
  async diagnose() {
    const out = { publicIp: null, routerIp: null, upnp: false, cgnat: false, ipv6: netinfo.globalIPv6()[0] || null };
    try { out.publicIp = (await stun.getPublicIPv4()).ip; } catch (_) { /* нет STUN */ }
    try {
      const gw = await upnp.discoverGateway(2500);
      if (gw) {
        out.upnp = true;
        out.routerIp = await gw.getExternalIP().catch(() => null);
        out.cgnat = !!out.routerIp && netinfo.isNonPublicV4(out.routerIp);
      }
    } catch (_) { /* UPnP недоступен */ }
    return out;
  }
}

module.exports = { HostSession, HostError };
