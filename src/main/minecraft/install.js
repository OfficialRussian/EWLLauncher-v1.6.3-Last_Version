'use strict';
/**
 * Установка версии Minecraft: client.jar, библиотеки, ассеты, конфиг логирования.
 * Распаковка natives для старых версий. Всё идемпотентно: уже скачанное не загружается повторно.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('../core/http');
const { gamePaths } = require('../core/paths');
const { currentContext, isAllowed } = require('./rules');
const versions = require('./versions');

const LIB_BASE = 'https://libraries.minecraft.net/';
const ASSET_BASE = 'https://resources.download.minecraft.net/';
const VERIFIED_MARK = '.ewl-verified-v2';

/** group:artifact:version[:classifier][@ext] -> относительный maven-путь */
function mavenPath(name) {
  let n = String(name);
  let ext = 'jar';
  const at = n.indexOf('@');
  if (at >= 0) { ext = n.slice(at + 1); n = n.slice(0, at); }
  const [g, a, ver, cls] = n.split(':');
  if (!g || !a || !ver) throw new Error(`Некорректное имя библиотеки: ${name}`);
  return `${g.replace(/\./g, '/')}/${a}/${ver}/${a}-${ver}${cls ? `-${cls}` : ''}.${ext}`;
}

/** Класспас, список загрузок и natives-архивов для разрешённых библиотек. */
function collectLibraries(root, v, ctx = currentContext()) {
  const P = gamePaths(root);
  const classpath = [];
  const downloads = [];
  const natives = [];
  const seenCp = new Set();
  const seenDl = new Set();

  const addDownload = (art) => {
    const dest = path.join(P.libraries, ...String(art.path).split('/'));
    if (!seenDl.has(dest)) {
      seenDl.add(dest);
      downloads.push({ url: art.url, dest, sha1: art.sha1, size: art.size });
    }
    return dest;
  };
  const addCp = (dest) => {
    if (!seenCp.has(dest)) { seenCp.add(dest); classpath.push(dest); }
  };

  for (const lib of v.libraries || []) {
    if (!isAllowed(lib.rules, ctx)) continue;

    if (lib.natives && lib.natives[ctx.platform]) {
      const cls = lib.natives[ctx.platform].replace('${arch}', ctx.arch === 'x86' ? '32' : '64');
      const art = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[cls];
      if (art) {
        natives.push({ path: addDownload(art), exclude: (lib.extract && lib.extract.exclude) || [] });
      }
      if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) {
        addCp(addDownload(lib.downloads.artifact));
      }
      continue;
    }

    let art = lib.downloads && lib.downloads.artifact;
    if (!art && lib.name) { // Fabric/Quilt: только maven-координаты и базовый url
      const p = mavenPath(lib.name);
      art = { path: p, url: `${(lib.url || LIB_BASE).replace(/\/?$/, '/')}${p}` };
    }
    if (!art || !art.path) continue;
    addCp(addDownload(art));
  }
  return { classpath, downloads, natives };
}

function throttle(fn, ms) {
  let last = 0;
  return (force) => {
    const now = Date.now();
    if (force || now - last >= ms) { last = now; fn(); }
  };
}

/** Скачивает недостающее. range=[from,to] — доля общего прогресса, которую занимает этот этап. */
async function downloadAll(tasks, { label, range, onProgress, signal, concurrency = 12, strict = false }) {
  const [from, to] = range;
  const todo = [];
  const list = tasks.filter((t) => t.url);
  if (strict) {
    // Первая проверка версии: сверяем контрольные суммы уже скачанных файлов, битые перекачиваем.
    let checked = 0;
    const tick = throttle(() => onProgress({ text: `${label}: проверка файлов ${checked}/${list.length}`, fraction: from }), 200);
    await http.runPool(list, 8, async (t) => {
      if (!(await http.fileValid(t.dest, { size: t.size, sha1: t.sha1 }))) todo.push(t);
      checked++;
      tick();
    }, signal);
  } else {
    for (const t of list) {
      if (!(await http.fileOk(t.dest, t.size))) todo.push(t);
    }
  }
  if (todo.length === 0) {
    onProgress({ text: `${label}: всё на месте`, fraction: to });
    return 0;
  }
  const totalBytes = todo.reduce((s, t) => s + (t.size || 0), 0);
  let doneBytes = 0;
  let doneFiles = 0;
  const emit = throttle(() => {
    const frac = totalBytes ? Math.min(1, doneBytes / totalBytes) : doneFiles / todo.length;
    onProgress({ text: `${label}: ${doneFiles}/${todo.length}`, fraction: from + (to - from) * frac });
  }, 150);
  emit(true);

  await http.runPool(todo, concurrency, async (t) => {
    await http.downloadFile(t.url, t.dest, {
      sha1: t.sha1, size: t.size, signal,
      onBytes: (n) => { doneBytes += n; emit(); },
    });
    doneFiles++;
    emit();
  }, signal);
  emit(true);
  return todo.length;
}

async function mirrorLegacyAssets(root, index, objectsDir) {
  const P = gamePaths(root);
  const base = index.map_to_resources ? path.join(root, 'resources') : P.assetVirtual;
  for (const [name, obj] of Object.entries(index.objects || {})) {
    const dst = path.resolve(base, name);
    if (!dst.startsWith(path.resolve(base) + path.sep)) continue; // защита от ../
    if (await http.fileOk(dst, obj.size)) continue;
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(path.join(objectsDir, obj.hash.slice(0, 2), obj.hash), dst);
  }
}

/** Устанавливает версию целиком. Возвращает итоговое описание версии. */
async function installVersion(root, id, { onProgress = () => {}, signal, manifest } = {}) {
  const P = gamePaths(root);
  onProgress({ text: 'Получение описания версии…', fraction: 0.01 });
  await versions.ensureVersionJson(root, id, { manifest, signal });
  const v = await versions.resolveVersion(root, id);
  // Метка «версия полностью проверена по контрольным суммам». Без неё проверяем все файлы заново.
  const marker = path.join(P.versionDir(id), VERIFIED_MARK);
  const strict = !(await http.fileOk(marker));

  // 1. client.jar
  const jarDest = P.versionJar(v._jarId);
  if (v.downloads && v.downloads.client) {
    const c = v.downloads.client;
    await downloadAll([{ url: c.url, dest: jarDest, sha1: c.sha1, size: c.size }],
      { label: 'Клиент игры', range: [0.02, 0.12], onProgress, signal, strict });
  } else if (!(await http.fileOk(jarDest))) {
    throw new Error(`Для версии ${v._jarId} нет клиентского jar-файла`);
  }

  // 2. библиотеки
  const libs = collectLibraries(root, v);
  await downloadAll(libs.downloads, { label: 'Библиотеки', range: [0.12, 0.3], onProgress, signal, strict });
  for (const l of libs.downloads) {
    if (!l.url && !(await http.fileOk(l.dest))) throw new Error(`Не найдена библиотека: ${l.dest}`);
  }

  // 3. ассеты
  if (v.assetIndex) {
    const ai = v.assetIndex;
    const idxFile = path.join(P.assetIndexes, `${ai.id}.json`);
    if (!(await http.fileValid(idxFile, { size: ai.size, sha1: ai.sha1 }))) {
      await http.downloadFile(ai.url, idxFile, { sha1: ai.sha1, size: ai.size, signal });
    }
    const index = JSON.parse(await fsp.readFile(idxFile, 'utf8'));
    const tasks = [];
    const seen = new Set();
    for (const obj of Object.values(index.objects || {})) {
      if (seen.has(obj.hash)) continue;
      seen.add(obj.hash);
      const p2 = obj.hash.slice(0, 2);
      tasks.push({ url: `${ASSET_BASE}${p2}/${obj.hash}`, dest: path.join(P.assetObjects, p2, obj.hash), sha1: obj.hash, size: obj.size });
    }
    await downloadAll(tasks, { label: 'Ресурсы игры', range: [0.3, 0.96], onProgress, signal, concurrency: 16, strict });
    if (index.virtual || index.map_to_resources) await mirrorLegacyAssets(root, index, P.assetObjects);
  }

  // 4. конфиг логирования (защита от Log4Shell в старых версиях)
  const lc = v.logging && v.logging.client && v.logging.client.file;
  if (lc && lc.url) {
    await downloadAll([{ url: lc.url, dest: path.join(P.logConfigs, lc.id), sha1: lc.sha1, size: lc.size }],
      { label: 'Конфигурация логов', range: [0.96, 1], onProgress, signal, strict });
  }
  await fsp.mkdir(path.dirname(marker), { recursive: true });
  await fsp.writeFile(marker, new Date().toISOString());
  onProgress({ text: 'Версия установлена', fraction: 1 });
  return v;
}

/** Распаковка нативных библиотек (только версии со старой схемой natives). */
async function prepareNatives(root, id, natives) {
  const dir = gamePaths(root).natives(id);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(dir, { recursive: true });
  if (!natives.length) return dir;
  const AdmZip = require('adm-zip');
  const base = path.resolve(dir) + path.sep;
  for (const n of natives) {
    const zip = new AdmZip(n.path);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName;
      if (name.startsWith('META-INF')) continue;
      if ((n.exclude || []).some((ex) => name.startsWith(ex))) continue;
      const dst = path.resolve(dir, name);
      if (!dst.startsWith(base)) continue; // zip-slip
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      try { await fsp.writeFile(dst, entry.getData()); } catch (_) { /* файл занят запущенной игрой — он уже на месте */ }
    }
  }
  return dir;
}

module.exports = { installVersion, collectLibraries, prepareNatives, mavenPath, downloadAll };
