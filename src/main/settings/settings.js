'use strict';
/** Настройки лаунчера: значения по умолчанию, проверка/нормализация, сохранение в settings.json. */
const os = require('os');
const path = require('path');
const { JsonStore } = require('../core/store');
const { userDataDir, defaultGameDir } = require('../core/paths');

const totalMemMb = () => Math.floor(os.totalmem() / 1024 / 1024);

const DEFAULTS = () => ({
  gameDir: defaultGameDir(),
  ramMax: Math.min(4096, Math.max(2048, Math.floor(totalMemMb() / 2 / 512) * 512)),
  ramMin: 512,
  javaPath: '',
  useBundledJava: true,
  jvmArgs: '',
  width: 854,
  height: 480,
  fullscreen: false,
  closeOnLaunch: false,
  msClientId: '',
  lastVersion: '',
  lastAccountId: '',
  accent: '#3ddc84',
  theme: 'dark',
  checkUpdates: true,
  curseforgeKey: '',
  discordPresence: true,
  performanceMode: false,
  updateRepo: 'OfficialRussian/serfgg',
  optimizeAsk: true,
  optimizeDeclined: [],
  welcomeAnimation: true,
  profileNames: {},
  profileConfig: {},
  serverList: [],
  server: {
    versionId: '',
    port: 25565,
    ramMax: 2048,
    onlineMode: true,
    whitelist: true,
    maxPlayers: 8,
    motd: 'EWLLauncher server',
    eulaAccepted: false,
  },
  host: { source: 'managed', port: 25565, versionId: '', ttlMinutes: 240 },
  join: { allowLocal: false },
});

const int = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const str = (v, max, fallback) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const oneLine = (v, max, fallback) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : fallback);

function normalize(input, base) {
  const out = JSON.parse(JSON.stringify(base));
  const p = input || {};
  const maxRam = Math.max(2048, totalMemMb());

  if ('gameDir' in p) {
    const d = str(p.gameDir, 260, '');
    if (d) out.gameDir = path.resolve(d);
  }
  if ('ramMax' in p) out.ramMax = int(p.ramMax, 512, maxRam, out.ramMax);
  if ('ramMin' in p) out.ramMin = int(p.ramMin, 128, maxRam, out.ramMin);
  if (out.ramMin > out.ramMax) out.ramMin = out.ramMax;
  if ('javaPath' in p) out.javaPath = str(p.javaPath, 400, '');
  if ('useBundledJava' in p) out.useBundledJava = bool(p.useBundledJava, out.useBundledJava);
  if ('jvmArgs' in p) out.jvmArgs = oneLine(p.jvmArgs, 2000, '');
  if ('width' in p) out.width = int(p.width, 320, 7680, out.width);
  if ('height' in p) out.height = int(p.height, 240, 4320, out.height);
  if ('fullscreen' in p) out.fullscreen = bool(p.fullscreen, out.fullscreen);
  if ('closeOnLaunch' in p) out.closeOnLaunch = bool(p.closeOnLaunch, out.closeOnLaunch);
  if ('msClientId' in p) {
    const id = str(p.msClientId, 80, '');
    out.msClientId = /^[0-9a-fA-F-]{8,64}$/.test(id) ? id : '';
  }
  if ('lastVersion' in p) out.lastVersion = str(p.lastVersion, 100, '');
  if ('lastAccountId' in p) out.lastAccountId = str(p.lastAccountId, 100, '');
  if ('accent' in p) out.accent = /^#[0-9a-fA-F]{6}$/.test(String(p.accent)) ? String(p.accent).toLowerCase() : out.accent;
  if ('theme' in p) out.theme = ['dark', 'light', 'midnight', 'amoled'].includes(p.theme) ? p.theme : out.theme;
  if ('curseforgeKey' in p) {
    const k = str(p.curseforgeKey, 120, '');
    out.curseforgeKey = k === '' || /^[A-Za-z0-9$./_-]{20,100}$/.test(k) ? k : out.curseforgeKey;
  }
  if ('performanceMode' in p) out.performanceMode = bool(p.performanceMode, out.performanceMode);
  if ('discordPresence' in p) out.discordPresence = bool(p.discordPresence, out.discordPresence);
  if ('checkUpdates' in p) out.checkUpdates = bool(p.checkUpdates, out.checkUpdates);
  if ('updateRepo' in p) out.updateRepo = /^[A-Za-z0-9._-]{1,60}\/[A-Za-z0-9._-]{1,100}$/.test(String(p.updateRepo).trim()) ? String(p.updateRepo).trim() : (String(p.updateRepo).trim() === '' ? '' : out.updateRepo);
  if ('optimizeAsk' in p) out.optimizeAsk = bool(p.optimizeAsk, out.optimizeAsk);
  if (Array.isArray(p.optimizeDeclined)) out.optimizeDeclined = [...new Set(p.optimizeDeclined.map((x) => str(x, 100, '')).filter(Boolean))].slice(0, 200);
  if ('welcomeAnimation' in p) out.welcomeAnimation = bool(p.welcomeAnimation, out.welcomeAnimation);
  if (p.profileNames && typeof p.profileNames === 'object' && !Array.isArray(p.profileNames)) {
    // Отображаемые имена сборок: id профиля -> имя. Передаётся целиком, пустые значения убирают имя.
    const names = {};
    for (const [id, name] of Object.entries(p.profileNames).slice(0, 300)) {
      if (String(id).length > 100) continue;
      const key = str(id, 100, '');
      const val = oneLine(name, 40, '');
      if (key && val) names[key] = val;
    }
    out.profileNames = names;
  }
  if (Array.isArray(p.serverList)) {
    // Избранные серверы: имя, адрес (только имя хоста/IP) и порт.
    const seen = new Set();
    out.serverList = [];
    for (const x of p.serverList.slice(0, 50)) {
      if (!x || typeof x !== 'object') continue;
      const host = str(x.host, 253, '');
      if (!/^[A-Za-z0-9._-]{1,253}$/.test(host)) continue;
      const port = int(x.port, 1, 65535, 25565);
      const key = `${host.toLowerCase()}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.serverList.push({ name: oneLine(x.name, 40, '') || host, host, port });
    }
  }
  if (p.profileConfig && typeof p.profileConfig === 'object' && !Array.isArray(p.profileConfig)) {
    // Личные настройки сборки: ramMax (МБ, 0 = как в общих настройках) и дополнительные JVM-аргументы.
    const cfg = {};
    for (const [id, c] of Object.entries(p.profileConfig).slice(0, 300)) {
      if (String(id).length > 100 || !c || typeof c !== 'object') continue;
      const key = str(id, 100, '');
      const ramMax = c.ramMax ? int(c.ramMax, 512, maxRam, 0) : 0;
      const jvmArgs = oneLine(c.jvmArgs, 1000, '');
      if (key && (ramMax || jvmArgs)) cfg[key] = { ramMax, jvmArgs };
    }
    out.profileConfig = cfg;
  }

  if (p.server && typeof p.server === 'object') {
    const s = p.server;
    const o = out.server;
    if ('versionId' in s) o.versionId = str(s.versionId, 100, '');
    if ('port' in s) o.port = int(s.port, 1024, 65535, o.port);
    if ('ramMax' in s) o.ramMax = int(s.ramMax, 512, maxRam, o.ramMax);
    if ('onlineMode' in s) o.onlineMode = bool(s.onlineMode, o.onlineMode);
    if ('whitelist' in s) o.whitelist = bool(s.whitelist, o.whitelist);
    if ('maxPlayers' in s) o.maxPlayers = int(s.maxPlayers, 1, 200, o.maxPlayers);
    if ('motd' in s) o.motd = oneLine(s.motd, 100, o.motd);
    if ('eulaAccepted' in s) o.eulaAccepted = bool(s.eulaAccepted, o.eulaAccepted);
  }
  if (p.host && typeof p.host === 'object') {
    const h = p.host;
    const o = out.host;
    if ('source' in h) o.source = h.source === 'existing' ? 'existing' : 'managed';
    if ('port' in h) o.port = int(h.port, 1, 65535, o.port);
    if ('versionId' in h) o.versionId = str(h.versionId, 100, '');
    if ('ttlMinutes' in h) o.ttlMinutes = int(h.ttlMinutes, 5, 1440, o.ttlMinutes);
  }
  if (p.join && typeof p.join === 'object') {
    if ('allowLocal' in p.join) out.join.allowLocal = bool(p.join.allowLocal, out.join.allowLocal);
  }
  return out;
}

class Settings {
  constructor() {
    this.store = new JsonStore(path.join(userDataDir(), 'settings.json'), DEFAULTS());
  }

  load() {
    const raw = this.store.load();
    this.store.data = normalize(raw, DEFAULTS());
    return this.get();
  }

  get() {
    return JSON.parse(JSON.stringify(this.store.data));
  }

  update(patch) {
    this.store.data = normalize(patch, this.store.data);
    this.store.save();
    return this.get();
  }
}

module.exports = { Settings, normalize, DEFAULTS, totalMemMb };
