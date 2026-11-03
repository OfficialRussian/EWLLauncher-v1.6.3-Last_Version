'use strict';
/**
 * Все пути лаунчера — в одном месте.
 *  - userDataDir()  : папка настроек/аккаунтов/логов лаунчера (%APPDATA%\EWLLauncher)
 *  - defaultGameDir(): папка игры по умолчанию (%APPDATA%\.ewllauncher)
 *  - gamePaths(root): раскладка внутри папки игры (versions, libraries, assets, runtime, servers)
 */
const os = require('os');
const path = require('path');

function userDataDir() {
  if (process.env.EWL_DATA_DIR) return process.env.EWL_DATA_DIR;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (_) { /* запуск вне Electron (тесты) */ }
  return path.join(os.homedir(), '.ewllauncher-data');
}

function defaultGameDir() {
  if (process.env.EWL_GAME_DIR) return process.env.EWL_GAME_DIR;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, '.ewllauncher');
}

const ID_RE = /^[A-Za-z0-9._+\- ]{1,100}$/;

/** Защита от path traversal: id версии становится именем папки. */
function assertSafeId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..')) {
    throw new Error(`Недопустимый идентификатор версии: ${String(id).slice(0, 60)}`);
  }
  return id;
}

function gamePaths(root) {
  const j = (...p) => path.join(root, ...p);
  return {
    root,
    versions: j('versions'),
    libraries: j('libraries'),
    assets: j('assets'),
    assetIndexes: j('assets', 'indexes'),
    assetObjects: j('assets', 'objects'),
    assetVirtual: j('assets', 'virtual', 'legacy'),
    logConfigs: j('assets', 'log_configs'),
    runtime: j('runtime'),
    servers: j('servers'),
    versionDir: (id) => j('versions', assertSafeId(id)),
    versionJson: (id) => j('versions', assertSafeId(id), `${id}.json`),
    versionJar: (id) => j('versions', assertSafeId(id), `${id}.jar`),
    natives: (id) => j('versions', assertSafeId(id), 'natives'),
    instance: (id) => j('instances', assertSafeId(id)),
  };
}

module.exports = { userDataDir, defaultGameDir, gamePaths, assertSafeId };
