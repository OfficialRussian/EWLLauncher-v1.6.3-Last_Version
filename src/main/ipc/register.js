'use strict';
/**
 * IPC: единственное место, где интерфейс (renderer) обращается к бизнес-логике.
 * Ответ на каждый invoke: { ok: true, data } | { ok: false, error: { message, code } }.
 * События main -> renderer отправляются через broadcast('evt:...').
 * Список каналов дублируется в preload.js (белый список) и описан в docs/ARCHITECTURE.md.
 */
const os = require('os');
const { ipcMain, dialog, shell, BrowserWindow, app } = require('electron');
const versions = require('../minecraft/versions');
const { installVersion } = require('../minecraft/install');
const loaders = require('../minecraft/loaders');
const optimize = require('../minecraft/optimize');
const libs = require('../minecraft/libs');
const skinLib = require('../skins/skins');
const market = require('../market/market');
const java = require('../minecraft/java');
const http = require('../core/http');
const { gamePaths } = require('../core/paths');
const { inspectInvite } = require('../multiplayer/join');
const invite = require('../multiplayer/invite');

const ALLOWED_HOSTS = ['microsoft.com', 'live.com', 'microsoftonline.com', 'xbox.com', 'minecraft.net',
  'mojang.com', 'aka.ms', 'azure.com', 'fabricmc.net', 'github.com'];

function isAllowedUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch (_) { return false; }
}

function register(services, getWindow) {
  const { logger, settings, accounts, game, server, host, skins, stats, presence } = services;

  const broadcast = (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  };

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        if (!http.isAbort(e)) logger.error(`${channel}: ${e.message}`);
        const extra = e.steps ? { steps: e.steps } : {};
        const message = e && e.cause ? http.friendlyNetworkError(e) : (e && e.message) || String(e);
        return { ok: false, error: { message, code: (e && (e.code || e.name)) || 'ERROR', ...extra } };
      }
    });
  };

  // ---------- события ----------
  logger.on('line', (line) => broadcast('evt:log', line));
  game.on('progress', (p) => broadcast('evt:progress', { scope: 'game', ...p }));
  game.on('started', (p) => {
    const st = settings.get();
    if (st.discordPresence !== false) {
      const name = (st.profileNames || {})[p.versionId] || p.versionId;
      presence.set({ details: 'Играет в Minecraft', state: String(name), startedAt: Date.now() }).catch(() => {});
    }
    broadcast('evt:game', { type: 'started', ...p });
    if (settings.get().closeOnLaunch) { const w = getWindow(); if (w) w.minimize(); }
  });
  game.on('exit', (p) => {
    presence.clear().catch(() => {});
    try { stats.record(game.versionId, p.ms); } catch (_) { /* статистика не критична */ }
    broadcast('evt:game', { type: 'exit', ...p });
    const w = getWindow();
    if (w && w.isMinimized()) w.restore();
  });
  server.on('log', (l) => broadcast('evt:server-log', l));
  server.on('state', (s) => broadcast('evt:server-state', s));
  server.on('progress', (p) => broadcast('evt:progress', { scope: 'server', ...p }));
  host.on('step', (s) => broadcast('evt:host-step', s));
  host.on('stopped', () => broadcast('evt:host-step', { id: '_stopped', status: 'info' }));

  // ---------- приложение / диалоги ----------
  handle('app:info', () => ({
    version: app.getVersion(), platform: process.platform, arch: process.arch,
    totalMemMb: Math.floor(os.totalmem() / 1024 / 1024), dataDir: require('../core/paths').userDataDir(),
  }));
  handle('app:openExternal', async (url) => {
    if (!isAllowedUrl(url)) throw new Error('Эта ссылка не разрешена.');
    await shell.openExternal(url);
  });
  handle('app:openPath', async (kind, id) => {
    const s = settings.get();
    const P = gamePaths(s.gameDir);
    let target = s.gameDir;
    if (kind === 'logs') target = logger.logsDir();
    else if (kind === 'server') target = server.dir();
    else if (kind === 'instance') target = id ? P.instance(String(id)) : s.gameDir;
    else if (kind === 'mods') target = require('path').join(P.instance(String(id)), 'mods');
    else if (kind === 'instances') target = require('path').join(s.gameDir, 'instances');
    else if (kind === 'data') target = require('../core/paths').userDataDir();
    else if (kind === 'skins') target = skins.dir();
    else if (kind === 'backups') target = require('path').join(s.gameDir, 'backups', id ? String(id).replace(/[\\/:*?"<>|]/g, '_') : '');
    else if (kind === 'crash') target = require('path').join(game.lastCwd || s.gameDir, 'crash-reports');
    if (!target) throw new Error('Папка недоступна.');
    await require('fs').promises.mkdir(target, { recursive: true });
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  });
  handle('app:checkUpdate', async () => {
    const st = settings.get();
    return require('../updates').check({ repo: st.updateRepo, current: app.getVersion() });
  });
  handle('app:logs', () => logger.tail(300));
  // Пути для окна «Файлы лаунчера».
  handle('app:paths', () => {
    const s = settings.get();
    const pth = require('path');
    return {
      game: s.gameDir, instances: pth.join(s.gameDir, 'instances'), data: require('../core/paths').userDataDir(),
      logs: logger.logsDir(), skins: skins.dir(), server: server.dir(),
    };
  });
  handle('dialog:pickFolder', async (defaultPath) => {
    const r = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'], defaultPath: defaultPath || undefined });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pickFile', async (kind) => {
    const filters = kind === 'java' ? [{ name: 'Java', extensions: ['exe'] }] : [];
    const r = await dialog.showOpenDialog(getWindow(), { properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------- настройки ----------
  handle('settings:get', () => settings.get());
  handle('settings:update', (patch) => settings.update(patch));

  // ---------- аккаунты ----------
  let msAbort = null;
  handle('accounts:list', () => ({ accounts: accounts.list(), selectedId: accounts.store.data.selectedId }));
  handle('accounts:addOffline', (name) => accounts.addOffline(name));
  handle('accounts:select', (id) => accounts.select(id));
  handle('accounts:remove', (id) => accounts.remove(id));
  handle('accounts:msLogin', async () => {
    if (msAbort) throw new Error('Вход уже выполняется.');
    msAbort = new AbortController();
    try {
      return await accounts.loginMicrosoft(settings.get().msClientId, {
        signal: msAbort.signal,
        onCode: (c) => broadcast('evt:ms-code', c),
      });
    } finally {
      msAbort = null;
      broadcast('evt:ms-done', {});
    }
  });
  handle('accounts:msCancel', () => { if (msAbort) msAbort.abort(); });

  // ---------- версии ----------
  let installAbort = null;
  const installLibrariesSafe = async (root, id, signal, onProgress) => {
    try { return await libs.installLibraries({ root, versionId: id, signal, onProgress }); } catch (e) {
      if (http.isAbort(e)) throw e;
      logger.warn(`Библиотеки профиля ${id}: ${e.message}`);
      return { installed: [], skipped: [], error: http.friendlyNetworkError(e) };
    }
  };
  const runInstall = async (label, fn) => {
    if (installAbort) throw new Error('Уже выполняется другая установка.');
    installAbort = new AbortController();
    try {
      return await fn(installAbort.signal, (p) => broadcast('evt:progress', { scope: 'install', label, ...p }));
    } catch (e) {
      if (http.isAbort(e)) throw new Error('Установка отменена.');
      throw e;
    } finally {
      installAbort = null;
      broadcast('evt:progress', { scope: 'install', label, done: true });
    }
  };

  handle('versions:manifest', async () => {
    const m = await versions.fetchManifest(settings.get().gameDir);
    return {
      latest: m.latest, offline: !!m.offline,
      versions: m.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })),
    };
  });
  handle('versions:installed', () => versions.listInstalled(settings.get().gameDir));
  handle('versions:install', (id) => runInstall(id, async (signal, onProgress) => {
    await installVersion(settings.get().gameDir, id, { signal, onProgress });
    return id;
  }));
  handle('versions:loaders', ({ kind, mc }) => loaders.listLoaders(kind, mc));
  handle('versions:installLoader', ({ kind, mc, loader, optimizeMods }) => runInstall(`${loaders.KINDS[kind] ? loaders.KINDS[kind].label : kind} ${mc}`, async (signal, onProgress) => {
    const root = settings.get().gameDir;
    const part = (from, to) => (p) => onProgress({ text: p.text, fraction: from + (to - from) * p.fraction });
    const canMods = !(loaders.KINDS[kind] && loaders.KINDS[kind].installer); // Forge/NeoForge: моды Fabric не подходят
    const wantOpt = !!optimizeMods && canMods;
    const id = await loaders.installLoader(root, kind, mc, loader, { signal, settings: settings.get(), onProgress: part(0, canMods ? (wantOpt ? 0.6 : 0.8) : 1) });
    // Обязательная библиотека (Fabric API / Quilted Fabric API). Сбой сети не отменяет установку профиля.
    let library = null;
    if (canMods) library = await installLibrariesSafe(root, id, signal, part(wantOpt ? 0.6 : 0.8, wantOpt ? 0.75 : 1));
    let opt = null;
    if (wantOpt) opt = await optimize.installMods({ root, versionId: id, signal, onProgress: part(0.75, 1) });
    return { id, optimization: opt, library };
  }));
  handle('versions:installLibs', (id) => runInstall(`Библиотеки ${id}`, async (signal, onProgress) => {
    const r = await libs.installLibraries({ root: settings.get().gameDir, versionId: id, signal, onProgress });
    return r;
  }));
  handle('versions:libsStatus', (id) => libs.status(settings.get().gameDir, id));
  handle('versions:cancel', () => { if (installAbort) installAbort.abort(); });
  // Удаление сборки. withData — вместе с её папкой instances/<id> (миры, моды, настройки). Принимает id или { id, withData }.
  handle('versions:remove', async (arg) => {
    const id = typeof arg === 'string' ? arg : arg && arg.id;
    const withData = !!(arg && typeof arg === 'object' && arg.withData);
    if (!id) throw new Error('Не указана версия.');
    if (game.status().running && game.versionId === id) throw new Error('Эта версия сейчас запущена.');
    const root = settings.get().gameDir;
    await versions.removeVersion(root, id);
    if (withData) await versions.removeInstance(root, id);
    const cur = settings.get();
    const names = { ...cur.profileNames };
    delete names[id];
    const pcfg = { ...(cur.profileConfig || {}) };
    delete pcfg[id];
    try { stats.forget(id); } catch (_) { /* */ }
    settings.update({ profileNames: names, profileConfig: pcfg, optimizeDeclined: cur.optimizeDeclined.filter((x) => x !== id) });
    return { id, withData };
  });

  handle('java:detect', () => java.detectJavas());

  // ---------- оптимизация (моды производительности) ----------
  handle('opt:status', (id) => optimize.status(settings.get().gameDir, id));
  handle('opt:install', (id) => runInstall('Оптимизация', (signal, onProgress) => (
    optimize.installMods({ root: settings.get().gameDir, versionId: id, signal, onProgress }))));
  handle('opt:remove', (id) => optimize.removeMods(settings.get().gameDir, id));
  handle('opt:decline', (id) => {
    const cur = settings.get().optimizeDeclined;
    return settings.update({ optimizeDeclined: [...cur, String(id)] }).optimizeDeclined;
  });
  // Из чистой версии Minecraft делает оптимизированный профиль: Fabric + моды производительности.
  handle('opt:createProfile', ({ mc }) => runInstall(`Оптимизация ${mc}`, async (signal, onProgress) => {
    const root = settings.get().gameDir;
    const part = (from, to) => (p) => onProgress({ text: p.text, fraction: from + (to - from) * p.fraction });
    const list = await loaders.listLoaders('fabric', mc);
    const pick = list.find((l) => l.stable) || list[0];
    if (!pick) throw new Error(`Fabric пока не поддерживает Minecraft ${mc}.`);
    const id = await loaders.installLoader(root, 'fabric', mc, pick.version, { signal, onProgress: part(0, 0.6) });
    const library = await installLibrariesSafe(root, id, signal, part(0.6, 0.75));
    const opt = await optimize.installMods({ root, versionId: id, signal, onProgress: part(0.75, 1) });
    return { id, optimization: opt, library };
  }));

  // ---------- маркет модов ----------
  handle('market:sources', () => Object.values(market.SOURCES).map((x) => (x.id === 'curseforge' ? { ...x, available: require('../market/curseforge').validKey(settings.get().curseforgeKey) } : x)));
  handle('market:search', (q) => market.search({ ...(q || {}), curseforgeKey: settings.get().curseforgeKey }));
  handle('market:installed', (versionId) => market.listInstalled({ root: settings.get().gameDir, versionId }));
  handle('market:install', ({ versionId, project, title, source }) => runInstall(`Мод ${title || project}`, (signal, onProgress) => (
    market.install({ root: settings.get().gameDir, versionId, project, title, source, signal, onProgress, curseforgeKey: settings.get().curseforgeKey }))));
  const modpacks = require('../market/modpacks');
  handle('market:packSearch', (q) => modpacks.search(q || {}));
  handle('market:packVersions', (project) => modpacks.listVersions(project));
  handle('market:packInstall', ({ project, version, title }) => runInstall(`Модпак ${title || project}`, async (signal, onProgress) => {
    const r = await modpacks.install({ root: settings.get().gameDir, project, version, settings: settings.get(), signal, onProgress });
    const cur = settings.get();
    settings.update({ profileNames: { ...cur.profileNames, [r.id]: String(title || r.name).slice(0, 40) } });
    return r;
  }));
  handle('market:checkUpdates', (versionId) => market.checkUpdates({ root: settings.get().gameDir, versionId }));
  handle('market:update', ({ versionId, projects }) => runInstall('Обновление модов', (signal, onProgress) => {
    if (game.status().running && game.versionId === versionId) throw new Error('Сборка сейчас запущена. Закройте игру и повторите.');
    return market.update({ root: settings.get().gameDir, versionId, projects: Array.isArray(projects) ? projects.slice(0, 80) : [], signal, onProgress });
  }));
  handle('market:rollback', ({ versionId, projectId }) => {
    if (game.status().running && game.versionId === versionId) throw new Error('Сборка сейчас запущена. Закройте игру и повторите.');
    return market.rollback({ root: settings.get().gameDir, versionId, projectId });
  });
  handle('market:contentSearch', (q) => market.searchContent(q || {}));
  handle('market:contentInstall', ({ versionId, project, type, title }) => runInstall(`${title || project}`, (signal, onProgress) => (
    market.installContent({ root: settings.get().gameDir, versionId, project, type, title, signal, onProgress }))));
  handle('market:contentList', ({ versionId, type }) => market.listContent({ root: settings.get().gameDir, versionId, type }));
  handle('market:contentRemove', ({ versionId, type, filename }) => market.removeContent({ root: settings.get().gameDir, versionId, type, filename }));
  handle('market:remove', ({ versionId, filename }) => market.remove({ root: settings.get().gameDir, versionId, filename }));

  // ---------- сборки: настройки, бэкапы, копия, экспорт/импорт ----------
  const profilesLib = require('../profiles/profiles');
  const notRunning = (id) => { if (game.status().running && game.versionId === id) throw new Error('Сборка сейчас запущена. Закройте игру и повторите.'); };
  handle('profile:getConfig', (id) => (settings.get().profileConfig || {})[id] || { ramMax: 0, jvmArgs: '' });
  handle('profile:setConfig', ({ id, ramMax, jvmArgs }) => {
    const cfg = { ...(settings.get().profileConfig || {}) };
    cfg[String(id)] = { ramMax: Number(ramMax) || 0, jvmArgs: jvmArgs || '' };
    return settings.update({ profileConfig: cfg }).profileConfig[String(id)] || { ramMax: 0, jvmArgs: '' };
  });
  handle('profile:worlds', (id) => profilesLib.listWorlds(settings.get().gameDir, id));
  handle('profile:backups', (id) => profilesLib.listBackups(settings.get().gameDir, id));
  handle('profile:backup', ({ id, worlds }) => { notRunning(id); return profilesLib.backupWorlds({ root: settings.get().gameDir, id, worlds }); });
  handle('profile:restore', ({ id, file }) => { notRunning(id); return profilesLib.restoreBackup({ root: settings.get().gameDir, id, file }); });
  handle('profile:removeBackup', ({ id, file }) => profilesLib.removeBackup({ root: settings.get().gameDir, id, file }));
  handle('profile:duplicate', async (id) => {
    const r = await profilesLib.duplicate({ root: settings.get().gameDir, id });
    const cur = settings.get();
    const base = (cur.profileNames || {})[id] || id;
    const patch = { profileNames: { ...cur.profileNames, [r.id]: `${base} (копия)`.slice(0, 40) } };
    if ((cur.profileConfig || {})[id]) patch.profileConfig = { ...cur.profileConfig, [r.id]: cur.profileConfig[id] };
    settings.update(patch);
    return r;
  });
  handle('profile:export', async ({ id, name, loader, mc, includeWorlds }) => {
    const r = await dialog.showSaveDialog(getWindow(), {
      defaultPath: `${String(name || id).replace(/[\\/:*?"<>|]/g, '_')}.ewlpack.zip`,
      filters: [{ name: 'Сборка EWLLauncher', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const config = (settings.get().profileConfig || {})[id] || null;
    return profilesLib.exportProfile({ root: settings.get().gameDir, id, file: r.filePath, name, loader, mc, includeWorlds: !!includeWorlds, config });
  });
  handle('profile:import', async () => {
    const r = await dialog.showOpenDialog(getWindow(), { properties: ['openFile'], filters: [{ name: 'Сборка EWLLauncher', extensions: ['zip'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const res = await profilesLib.importProfile({ root: settings.get().gameDir, file: r.filePaths[0] });
    const cur = settings.get();
    const patch = { profileNames: { ...cur.profileNames, [res.id]: String(res.copied ? `${res.name} (импорт)` : res.name).slice(0, 40) } };
    if (res.config) patch.profileConfig = { ...cur.profileConfig, [res.id]: res.config };
    settings.update(patch);
    return res;
  });

  // ---------- скины ----------
  const fs = require('fs');
  const pngOf = (dataUrl) => skinLib.parseDataUrl(dataUrl);
  const msAccount = (id) => {
    const a = accounts.list().find((x) => x.id === id);
    if (!a || a.type !== 'microsoft') throw new Error('Для этого нужен аккаунт Microsoft (лицензия). Офлайн-аккаунты не имеют профиля Mojang.');
    return a;
  };
  handle('skin:list', () => skins.list());
  handle('skin:save', ({ name, dataUrl }) => skins.save(name, dataUrl));
  handle('skin:remove', (name) => skins.remove(name));
  handle('skin:import', async () => {
    const r = await dialog.showOpenDialog(getWindow(), { properties: ['openFile'], filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const buf = await fs.promises.readFile(r.filePaths[0]);
    skinLib.validatePng(buf);
    return skinLib.toDataUrl(buf);
  });
  handle('skin:export', async ({ name, dataUrl }) => {
    const buf = pngOf(dataUrl);
    const r = await dialog.showSaveDialog(getWindow(), { defaultPath: `${String(name || 'skin').replace(/[\\/:*?"<>|]/g, '_')}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (r.canceled || !r.filePath) return false;
    await fs.promises.writeFile(r.filePath, buf);
    return true;
  });
  handle('skin:current', async (accountId) => skinLib.fetchCurrentSkin(msAccount(accountId).uuid));
  handle('skin:upload', async ({ accountId, dataUrl, variant }) => {
    msAccount(accountId);
    const png = pngOf(dataUrl);
    const prof = await accounts.getLaunchProfile(accountId, { clientId: settings.get().msClientId });
    await skinLib.uploadSkin(prof.accessToken, png, variant);
    return true;
  });

  // ---------- игра ----------
  handle('game:status', () => game.status());
  handle('game:launch', async ({ versionId, accountId }) => {
    settings.update({ lastVersion: versionId, lastAccountId: accountId });
    return game.launch({ versionId, accountId });
  });
  handle('game:cancel', () => game.cancel());
  handle('game:stop', () => game.stop());

  // ---------- сервер / подключение к другу ----------
  handle('mp:server:info', () => server.info());
  handle('mp:server:start', async (cfg) => {
    const patch = { server: cfg };
    const saved = settings.update(patch).server;
    const sel = accounts.list().find((a) => a.selected);
    return server.start({ ...saved, owner: sel ? sel.name : '' });
  });
  handle('mp:server:stop', () => server.stop());
  handle('mp:server:cancel', () => server.cancel());
  handle('mp:server:command', (cmd) => server.command(cmd));
  handle('mp:server:whitelistAdd', (name) => server.whitelistAdd(name));

  handle('mp:host:start', async (opts) => {
    const s = settings.update({ host: opts }).host;
    const sel = accounts.list().find((a) => a.selected);
    const versionId = s.source === 'managed' ? settings.get().server.versionId : s.versionId;
    return host.start({
      port: s.source === 'managed' ? settings.get().server.port : s.port,
      versionId,
      hostName: sel ? sel.name : '',
      ttlMinutes: s.ttlMinutes,
      manualForward: !!opts.manualForward,
    });
  });
  handle('mp:host:stop', () => host.stop());
  handle('mp:host:status', () => host.status());
  handle('mp:net:diagnose', () => host.diagnose());

  // ---------- статистика и скриншоты ----------
  handle('app:stats', () => stats.get());
  const shotDirs = async () => {
    const root = settings.get().gameDir;
    const pth = require('path');
    const out = [{ profile: '', dir: pth.join(root, 'screenshots') }];
    let names = [];
    try { names = await require('fs').promises.readdir(pth.join(root, 'instances')); } catch (_) { /* нет профилей */ }
    for (const n of names) out.push({ profile: n, dir: pth.join(root, 'instances', n, 'screenshots') });
    return out;
  };
  const shotPath = async (profile, file) => {
    const pth = require('path');
    const f = pth.basename(String(file || ''));
    if (f !== file || !/\.png$/i.test(f)) throw new Error('Некорректное имя файла.');
    const dirs = await shotDirs();
    const hit = dirs.find((d) => d.profile === String(profile || ''));
    if (!hit) throw new Error('Папка скриншотов не найдена.');
    return pth.join(hit.dir, f);
  };
  handle('app:screenshots', async () => {
    const { nativeImage } = require('electron');
    const fsp2 = require('fs').promises;
    const pth = require('path');
    const all = [];
    for (const d of await shotDirs()) {
      let names = [];
      try { names = await fsp2.readdir(d.dir); } catch (_) { continue; }
      for (const f of names) {
        if (!/\.png$/i.test(f)) continue;
        try { all.push({ profile: d.profile, file: f, mtime: (await fsp2.stat(pth.join(d.dir, f))).mtimeMs, dir: d.dir }); } catch (_) { /* исчез */ }
      }
    }
    all.sort((a, b) => b.mtime - a.mtime);
    const out = [];
    for (const s of all.slice(0, 48)) {
      let thumb = '';
      try {
        const img = nativeImage.createFromPath(pth.join(s.dir, s.file));
        if (!img.isEmpty()) thumb = img.resize({ width: 320 }).toDataURL();
      } catch (_) { /* битый файл */ }
      out.push({ profile: s.profile, file: s.file, mtime: s.mtime, thumb });
    }
    return { total: all.length, items: out };
  });
  handle('app:screenshotOpen', async ({ profile, file }) => {
    const err = await shell.openPath(await shotPath(profile, file));
    if (err) throw new Error(err);
  });
  handle('app:screenshotDelete', async ({ profile, file }) => { await require('fs').promises.rm(await shotPath(profile, file), { force: true }); });
  handle('app:screenshotFolder', async () => {
    const dirs = await shotDirs();
    const target = dirs[0].dir;
    await require('fs').promises.mkdir(target, { recursive: true });
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  });

  // ---------- избранные серверы ----------
  const pinger = require('../multiplayer/ping');
  handle('mp:serverList', () => settings.get().serverList);
  handle('mp:serverSave', (list) => settings.update({ serverList: list }).serverList);
  handle('mp:serverPing', ({ host, port }) => pinger.ping({ host, port: Number(port) || 25565 }));
  handle('mp:serverPlay', async ({ host, port, versionId, accountId }) => {
    if (!pinger.validHost(host)) throw new Error('Некорректный адрес сервера.');
    if (!versionId) throw new Error('Выберите версию Minecraft.');
    settings.update({ lastVersion: versionId, lastAccountId: accountId });
    logger.info(`Запуск с подключением к ${host}:${port || 25565}`);
    await game.launch({ versionId, accountId, quickPlay: { host, port: Number(port) || 25565 } });
    return { address: `${host}:${port || 25565}` };
  });
  handle('mp:join:inspect', ({ code }) => inspectInvite(code, { allowLocal: settings.get().join.allowLocal }));
  handle('mp:join:launch', async ({ code, accountId, versionId }) => {
    const info = await inspectInvite(code, { allowLocal: settings.get().join.allowLocal });
    if (!info.best) {
      throw Object.assign(new Error('Сервер недоступен ни по одному адресу из приглашения.'), { code: 'UNREACHABLE' });
    }
    const ver = versionId || info.invite.version;
    if (!ver) throw new Error('В приглашении нет версии — выберите версию Minecraft вручную.');
    settings.update({ lastVersion: ver, lastAccountId: accountId });
    const dec = invite.decode(code);
    logger.info(`Автоподключение к ${info.best.address} (приглашение от ${dec.name || '?'})`);
    await game.launch({ versionId: ver, accountId, quickPlay: { host: info.best.host, port: info.best.port } });
    return { address: info.best.address, version: ver };
  });

  void gamePaths;
}

module.exports = { register };
