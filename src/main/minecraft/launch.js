'use strict';
/**
 * Подготовка запуска: установка недостающего, выбор Java, распаковка natives,
 * сборка командной строки (JVM-аргументы + главный класс + аргументы игры).
 * Здесь НЕТ запуска процесса — он в game.js, чтобы сборку аргументов можно было тестировать.
 */
const path = require('path');
const fsp = require('fs').promises;
const { gamePaths } = require('../core/paths');
const { currentContext, isAllowed } = require('./rules');
const { installVersion, collectLibraries, prepareNatives } = require('./install');
const { ensureJava } = require('./java');

const LAUNCHER_NAME = 'EWLLauncher';
const LAUNCHER_VERSION = '1.0.0';

/** Разбор строки аргументов с учётом кавычек: -Dfoo="a b" -Xmx1G */
function splitArgs(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(s || '')) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function flattenArgs(list, ctx) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') out.push(item);
    else if (item && isAllowed(item.rules, ctx)) {
      if (Array.isArray(item.value)) out.push(...item.value);
      else if (item.value != null) out.push(item.value);
    }
  }
  return out;
}

const fill = (s, vars) => String(s).replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/**
 * Собирает полный список аргументов Java.
 * quickPlay = { host, port } — автоподключение к серверу после запуска.
 */
function buildArguments({ v, vars, ctx, settings, quickPlay }) {
  let jvm;
  let game;
  if (v.arguments) {
    jvm = flattenArgs(v.arguments.jvm, ctx);
    game = flattenArgs(v.arguments.game, ctx);
  } else { // старый формат (до 1.13)
    jvm = ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'];
    game = splitArgs(v.minecraftArguments);
    if (settings.width && settings.height && !game.includes('--width')) {
      game.push('--width', String(settings.width), '--height', String(settings.height));
    }
  }
  if (settings.fullscreen && !game.includes('--fullscreen')) game.push('--fullscreen');

  if (quickPlay) {
    const usesQuickPlay = game.some((a) => String(a).includes('${quickPlayMultiplayer}'));
    if (!usesQuickPlay) game.push('--server', quickPlay.host, '--port', String(quickPlay.port));
  }

  const memory = [`-Xmx${settings.ramMax}M`, `-Xms${Math.min(settings.ramMin, settings.ramMax)}M`];
  const user = splitArgs(settings.jvmArgs);
  const logArg = vars._logArg ? [vars._logArg] : [];

  const args = [
    ...memory,
    ...jvm.map((a) => fill(a, vars)),
    ...user,
    ...logArg,
    v.mainClass,
    ...game.map((a) => fill(a, vars)),
  ];
  return args;
}

/**
 * Путь к клиентскому jar. Для профилей с inheritsFrom это jar родителя, но Forge (1.17+) исключает клиент
 * из модульного слоя по имени `${version_name}.jar` (-DignoreList). Если на пути окажется ванильный
 * `1.20.1.jar`, Forge падает с ResolutionException (два модуля экспортируют один пакет).
 * Поэтому для таких профилей jar родителя копируется под именем профиля, как делает официальный лаунчер.
 */
async function resolveClientJar(root, v, versionId) {
  const P = gamePaths(root);
  const parentJar = P.versionJar(v._jarId);
  const jvm = (v.arguments && v.arguments.jvm) || [];
  const needsOwnName = v.inheritsFrom && v._jarId !== versionId && JSON.stringify(jvm).includes('${version_name}.jar');
  if (!needsOwnName) return parentJar;
  const own = P.versionJar(versionId);
  const src = await fsp.stat(parentJar);
  let same = false;
  try { same = (await fsp.stat(own)).size === src.size; } catch (_) { /* копии ещё нет */ }
  if (!same) {
    await fsp.mkdir(path.dirname(own), { recursive: true });
    await fsp.copyFile(parentJar, own);
  }
  return own;
}

/**
 * Готовит всё для запуска и возвращает { javaPath, args, cwd, secrets, javaInfo }.
 * profile = { name, uuid, accessToken, userType, xuid?, clientId? }
 */
async function prepareLaunch({ root, settings, versionId, profile, quickPlay, onProgress = () => {}, signal }) {
  const P = gamePaths(root);
  const part = (from, to) => (p) => onProgress({ text: p.text, fraction: from + (to - from) * p.fraction });

  const v = await installVersion(root, versionId, { onProgress: part(0, 0.85), signal });

  const javaInfo = await ensureJava({ root, version: v, settings, onProgress: part(0.85, 0.97), signal });

  onProgress({ text: 'Подготовка библиотек…', fraction: 0.97 });
  const ctx = currentContext({
    features: {
      has_custom_resolution: !!(settings.width && settings.height),
      has_quick_plays_support: !!quickPlay,
      is_quick_play_multiplayer: !!quickPlay,
      is_demo_user: false,
    },
  });
  const libs = collectLibraries(root, v, ctx);
  const nativesDir = await prepareNatives(root, versionId, libs.natives);
  const jarPath = await resolveClientJar(root, v, versionId);
  const classpath = [...libs.classpath, jarPath];

  const assetsId = (v.assetIndex && v.assetIndex.id) || v.assets || 'legacy';
  const virtualAssets = assetsId === 'legacy' || assetsId === 'pre-1.6';

  // Профили с загрузчиком модов живут в своей папке (свои моды/миры/настройки), ванильные — в общей.
  const gameDir = v.inheritsFrom ? P.instance(versionId) : root;
  await fsp.mkdir(gameDir, { recursive: true });
  const quickPlayDir = path.join(gameDir, 'quickPlay');
  await fsp.mkdir(quickPlayDir, { recursive: true });

  let logArg = '';
  const logCfg = v.logging && v.logging.client;
  if (logCfg && logCfg.argument && logCfg.file) {
    const logFile = path.join(P.logConfigs, logCfg.file.id);
    logArg = logCfg.argument.replace('${path}', logFile);
  }

  const vars = {
    auth_player_name: profile.name,
    version_name: versionId,
    game_directory: gameDir,
    assets_root: P.assets,
    assets_index_name: assetsId,
    game_assets: virtualAssets ? P.assetVirtual : P.assets,
    auth_uuid: profile.uuid,
    auth_access_token: profile.accessToken,
    auth_session: `token:${profile.accessToken}:${profile.uuid}`,
    clientid: profile.clientId || '0',
    auth_xuid: profile.xuid || '0',
    user_type: profile.userType,
    user_properties: '{}',
    version_type: v.type || 'release',
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath: classpath.join(path.delimiter),
    classpath_separator: path.delimiter,
    library_directory: P.libraries,
    primary_jar: jarPath,
    resolution_width: settings.width,
    resolution_height: settings.height,
    quickPlayPath: path.join(quickPlayDir, 'log.json'),
    quickPlayMultiplayer: quickPlay ? `${quickPlay.host}:${quickPlay.port}` : '',
    quickPlaySingleplayer: '',
    quickPlayRealms: '',
    _logArg: logArg,
  };

  const args = buildArguments({ v, vars, ctx, settings, quickPlay });
  onProgress({ text: 'Запуск игры…', fraction: 1 });
  return {
    javaPath: javaInfo.path,
    javaInfo,
    args,
    cwd: gameDir,
    secrets: [profile.accessToken].filter((s) => s && s !== '0'),
  };
}

module.exports = { prepareLaunch, buildArguments, resolveClientJar, splitArgs, flattenArgs, fill };
