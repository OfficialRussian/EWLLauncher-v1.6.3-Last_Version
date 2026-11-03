'use strict';
/**
 * Загрузчики модов: Fabric, Quilt (профили версий с meta-серверов), Forge и NeoForge (официальные установщики).
 * Профиль — это JSON с inheritsFrom=<версия Minecraft>; игра берёт у родителя клиент и ресурсы.
 *
 * Forge и NeoForge устроены иначе: профиль не отдаётся готовым JSON-ом, его создаёт installer.jar
 * (патчит клиент процессорами). Лаунчер скачивает установщик, проверяет его и запускает
 * `java -jar installer.jar --installClient <папка игры>` в режиме без окна (у NeoForge то же самое).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const http = require('../core/http');
const logger = require('../core/logger');
const { gamePaths } = require('../core/paths');
const { installVersion } = require('./install');
const { ensureJava } = require('./java');
const versions = require('./versions');

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_TIMEOUT_MS = 30 * 60 * 1000;

const KINDS = {
  fabric: { label: 'Fabric', meta: 'https://meta.fabricmc.net/v2' },
  quilt: { label: 'Quilt', meta: 'https://meta.quiltmc.org/v3' },
  forge: { label: 'Forge', installer: true },
  neoforge: { label: 'NeoForge', installer: true },
};

function kindInfo(kind) {
  if (!KINDS[kind]) throw new Error(`Неизвестный загрузчик: ${kind}`);
  return KINDS[kind];
}

const isStable = (v) => !/(alpha|beta|rc|pre|snapshot|dev)/i.test(String(v));

/** Сравнение версий вида 0.16.5 / 0.20.0-beta.9: релиз новее предрелиза. */
function compareVersions(a, b) {
  const split = (s) => {
    const m = /^([0-9.]+)(?:[-+](.*))?$/.exec(String(s));
    return { nums: (m ? m[1] : String(s)).split('.').map((n) => parseInt(n, 10) || 0), pre: m && m[2] ? m[2] : '' };
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const d = (A.nums[i] || 0) - (B.nums[i] || 0);
    if (d) return d;
  }
  if (!A.pre && B.pre) return 1;
  if (A.pre && !B.pre) return -1;
  return A.pre.localeCompare(B.pre, undefined, { numeric: true });
}

async function getText(url, signal) {
  const res = await http.request(url, { signal }, { retries: 2 });
  if (!res.ok) throw new http.HttpError(`HTTP ${res.status} (${url})`, res.status, url);
  return res.text();
}

/** Forge-установщик надёжно работает с 1.12.2; более старые версии (1.5–1.12.1) не поддерживаем. */
function forgeSupportsMc(mc) {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(String(mc));
  if (!m) return true; // нестандартные id (новая схема версий) — решает наличие сборок на maven
  const minor = parseInt(m[1], 10);
  const patch = parseInt(m[2] || '0', 10);
  return minor > 12 || (minor === 12 && patch >= 2);
}

/**
 * Версии Forge для Minecraft из maven-metadata.xml. value — всё после "<mc>-" (так задан путь на maven).
 * stable = «рекомендуемая» сборка по promotions_slim.json (если этот файл недоступен — просто без метки).
 */
function parseForgeMetadata(xml, mc, promos) {
  const out = [];
  const re = /<version>\s*([^<\s]+)\s*<\/version>/g;
  let m;
  while ((m = re.exec(String(xml)))) {
    const full = m[1];
    if (!full.startsWith(`${mc}-`)) continue;
    const version = full.slice(mc.length + 1);
    if (version) out.push(version);
  }
  const recommended = promos && promos[`${mc}-recommended`];
  const latest = promos && promos[`${mc}-latest`];
  const uniq = [...new Set(out)];
  const list = uniq.map((version) => ({ version, stable: version === recommended || (!recommended && version === latest) }));
  list.sort((a, b) => compareVersions(b.version, a.version));
  return list;
}

/** NeoForge существует для Minecraft 1.20.2 и новее (для 1.20.1 был отдельный артефакт, его не поддерживаем). */
function neoforgeSupportsMc(mc) {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(String(mc));
  if (!m) return true;
  const minor = parseInt(m[1], 10);
  const patch = parseInt(m[2] || '0', 10);
  return minor > 20 || (minor === 20 && patch >= 2);
}

/** Версия NeoForge начинается с «<мелкая>.<патч>.» версии Minecraft: 1.21.1 -> 21.1., 1.21 -> 21.0. */
function neoforgePrefix(mc) {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(String(mc));
  return m ? `${m[1]}.${m[2] || '0'}.` : `${mc}.`;
}

function parseNeoForgeMetadata(xml, mc) {
  const prefix = neoforgePrefix(mc);
  const out = new Set();
  const re = /<version>\s*([^<\s]+)\s*<\/version>/g;
  let m;
  while ((m = re.exec(String(xml)))) {
    if (m[1].startsWith(prefix)) out.add(m[1]);
  }
  const list = [...out].map((version) => ({ version, stable: isStable(version) }));
  list.sort((a, b) => compareVersions(b.version, a.version));
  return list;
}

/** Версии загрузчика для данной версии Minecraft, новые первыми. */
async function listLoaders(kind, mc) {
  const k = kindInfo(kind);
  if (kind === 'neoforge') {
    if (!neoforgeSupportsMc(mc)) return [];
    return parseNeoForgeMetadata(await getText(`${NEOFORGE_MAVEN}/maven-metadata.xml`), mc);
  }
  if (k.installer) {
    if (!forgeSupportsMc(mc)) return [];
    const xml = await getText(`${FORGE_MAVEN}/maven-metadata.xml`);
    let promos = null;
    try { promos = (await http.getJson(FORGE_PROMOS, {}, { retries: 1 })).promos; } catch (_) { /* метки не критичны */ }
    return parseForgeMetadata(xml, mc, promos);
  }
  const arr = await http.getJson(`${k.meta}/versions/loader/${encodeURIComponent(mc)}`);
  const out = arr.map((x) => ({
    version: x.loader.version,
    stable: kind === 'fabric' ? !!x.loader.stable : isStable(x.loader.version),
  }));
  out.sort((a, b) => compareVersions(b.version, a.version));
  return out;
}

const scaled = (onProgress, from, to) => (p) => onProgress({ text: p.text, fraction: from + (to - from) * p.fraction });

/** id профиля, который создаст установщик: version.json (1.13+) или install_profile.json (1.12.2). */
function readInstallerInfo(jarPath) {
  const AdmZip = require('adm-zip');
  let zip;
  try { zip = new AdmZip(jarPath); } catch (_) { throw new Error('Файл установщика Forge повреждён (это не jar-архив).'); }
  const readJson = (name) => {
    const e = zip.getEntry(name);
    if (!e) return null;
    try { return JSON.parse(zip.readAsText(e)); } catch (_) { return null; }
  };
  const profile = readJson('install_profile.json');
  if (!profile) throw new Error('Файл установщика Forge повреждён: нет install_profile.json.');
  const ver = readJson('version.json');
  const id = (ver && ver.id) || (profile.versionInfo && profile.versionInfo.id) || null;
  return { id, legacy: !ver };
}

/** Минимальный launcher_profiles.json: без него установщик Forge отказывается работать. */
async function ensureLauncherProfiles(root) {
  const file = path.join(root, 'launcher_profiles.json');
  try { await fsp.access(file); return; } catch (_) { /* создаём */ }
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(file, JSON.stringify({
    profiles: {}, selectedProfile: null, clientToken: 'ewllauncher', authenticationDatabase: {},
    launcherVersion: { name: 'EWLLauncher', format: 21 },
  }, null, 2));
}

/** Запуск установщика без окна. onLine вызывается на каждую строку вывода. Отмена убивает процесс. */
function runInstaller(javaPath, jarPath, root, { signal, onLine = () => {}, timeoutMs = FORGE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(http.abortError());
    const child = spawn(javaPath, ['-jar', jarPath, '--installClient', root], { cwd: path.dirname(jarPath), windowsHide: true });
    const tail = [];
    let buf = '';
    let finished = false;
    const feed = (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        onLine(line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const done = (fn, val) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(val);
    };
    const onAbort = () => { child.kill(); done(reject, http.abortError()); };
    const timer = setTimeout(() => { child.kill(); done(reject, new Error('Установщик завис (превышено время ожидания).')); }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => done(reject, new Error(`Не удалось запустить Java для установщика: ${e.message}`)));
    child.on('close', (code) => {
      if (buf.trim()) { tail.push(buf.trim()); onLine(buf.trim()); }
      if (code === 0) return done(resolve, { tail });
      const hint = tail.slice(-6).join('\n');
      done(reject, new Error(`Установщик завершился с ошибкой (код ${code}).${hint ? `\n${hint}` : ''}`));
    });
  });
}

const enc = encodeURIComponent;

/** Параметры установщиков: где лежит installer.jar и для каких версий Minecraft он подходит. */
const INSTALLERS = {
  forge: {
    supports: forgeSupportsMc,
    minText: 'минимум 1.12.2',
    full: (mc, v) => `${mc}-${v}`,
    url: (mc, v) => `${FORGE_MAVEN}/${enc(`${mc}-${v}`)}/forge-${enc(`${mc}-${v}`)}-installer.jar`,
  },
  neoforge: {
    supports: neoforgeSupportsMc,
    minText: 'минимум 1.20.2',
    full: (mc, v) => v,
    url: (mc, v) => `${NEOFORGE_MAVEN}/${enc(v)}/neoforge-${enc(v)}-installer.jar`,
  },
};

/**
 * Установка Forge/NeoForge. Шаги: Minecraft → установщик с maven (проверка sha1) → запуск → проверка профиля.
 * opts.java / opts.run — подмена Java и запуска установщика для тестов.
 */
async function installWithInstaller(kind, root, mc, forgeVersion, { onProgress = () => {}, signal, settings = {}, java, run = runInstaller } = {}) {
  const spec = INSTALLERS[kind];
  const label = KINDS[kind].label;
  if (!spec.supports(mc)) throw new Error(`${label} не поддерживается для Minecraft ${mc} (${spec.minText}).`);
  const P = gamePaths(root);
  const full = spec.full(mc, forgeVersion);

  await installVersion(root, mc, { onProgress: scaled(onProgress, 0, 0.35), signal });

  const parent = await versions.resolveVersion(root, mc);
  const javaInfo = java || await ensureJava({ root, version: parent, settings, onProgress: scaled(onProgress, 0.35, 0.45), signal });

  const dir = path.join(root, '.ewl-tmp');
  const jar = path.join(dir, `${kind}-${full}-installer.jar`);
  const url = spec.url(mc, forgeVersion);
  onProgress({ text: `Загрузка установщика ${label} ${forgeVersion}…`, fraction: 0.46 });
  let sha1;
  try { sha1 = (await getText(`${url}.sha1`, signal)).trim().split(/\s+/)[0]; } catch (e) {
    if (http.isAbort(e)) throw e;
    sha1 = undefined; // контрольной суммы нет — дальше проверим структуру архива
  }
  if (sha1 && !/^[0-9a-f]{40}$/i.test(sha1)) sha1 = undefined;
  await fsp.mkdir(dir, { recursive: true });
  await http.downloadFile(url, jar, { sha1, signal });

  const info = readInstallerInfo(jar);
  await ensureLauncherProfiles(root);
  const before = new Set((await versions.listInstalled(root)).map((x) => x.id));

  let lines = 0;
  logger.info(`${label}: запуск установщика ${full}`);
  await run(javaInfo.path, jar, root, {
    signal,
    onLine: (line) => {
      lines++;
      logger.info(`[${kind}-installer] ${line}`);
      const frac = 0.5 + 0.4 * (1 - Math.exp(-lines / 120)); // установщик не сообщает долю, растём плавно
      onProgress({ text: `${label}: ${line.length > 70 ? `${line.slice(0, 67)}…` : line}`, fraction: frac });
    },
  });

  // Какой профиль появился: заявленный в установщике либо новый forge-профиль для этой версии Minecraft.
  let id = info.id;
  if (!id || !(await http.fileOk(P.versionJson(id)))) {
    const now = await versions.listInstalled(root);
    const created = now.find((x) => !before.has(x.id) && x.loader === kind && x.mc === mc);
    id = created ? created.id : null;
  }
  if (!id || !(await http.fileOk(P.versionJson(id)))) {
    throw new Error(`Установщик ${label} закончил работу, но профиль не появился. Подробности в логе лаунчера.`);
  }

  // Проверка профиля: недостающие библиотеки докачаются, а те, что обязан создать установщик, должны быть на месте.
  await installVersion(root, id, { onProgress: scaled(onProgress, 0.92, 1), signal });
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  return id;
}

/** Установка: Minecraft + профиль загрузчика (+ его библиотеки). Возвращает id нового профиля. */
const installForge = (root, mc, version, opts) => installWithInstaller('forge', root, mc, version, opts);

async function installLoader(root, kind, mc, loaderVersion, opts = {}) {
  const k = kindInfo(kind);
  if (k.installer) return installWithInstaller(kind, root, mc, loaderVersion, opts);

  const { onProgress = () => {}, signal } = opts;
  await installVersion(root, mc, { onProgress: scaled(onProgress, 0, 0.7), signal });

  onProgress({ text: `Загрузка профиля ${k.label}…`, fraction: 0.72 });
  const profile = await http.getJson(
    `${k.meta}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loaderVersion)}/profile/json`,
    { signal });
  if (!profile || !profile.id || !profile.inheritsFrom) throw new Error(`${k.label} вернул некорректный профиль`);

  const P = gamePaths(root);
  const file = P.versionJson(profile.id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(profile, null, 2));

  await installVersion(root, profile.id, { onProgress: scaled(onProgress, 0.75, 1), signal });
  return profile.id;
}

/** Определяет тип профиля по id и JSON: { kind: 'fabric'|'quilt'|'forge'|'neoforge'|null, mc }. */
async function describe(root, id) {
  let json = null;
  try { json = await versions.readVersionJson(root, id); } catch (_) { /* нет файла */ }
  const kind = versions.loaderFromId(id, json);
  return { kind, mc: json && json.inheritsFrom ? json.inheritsFrom : id, json };
}

module.exports = {
  KINDS, listLoaders, installLoader, installForge, installWithInstaller, runInstaller, describe,
  compareVersions, isStable, parseForgeMetadata, parseNeoForgeMetadata, forgeSupportsMc, neoforgeSupportsMc, readInstallerInfo,
};
