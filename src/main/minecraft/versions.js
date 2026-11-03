'use strict';
/**
 * Версии Minecraft: манифест Mojang, список установленных, чтение и объединение
 * JSON-описаний (с поддержкой inheritsFrom — Fabric/Quilt и подобные).
 */
const fsp = require('fs').promises;
const path = require('path');
const http = require('../core/http');
const { gamePaths } = require('../core/paths');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

/** Манифест Mojang. Без интернета берётся последняя сохранённая копия (offline: true). */
async function fetchManifest(root) {
  const P = gamePaths(root);
  const cache = path.join(P.versions, 'version_manifest_v2.json');
  try {
    const m = await http.getJson(MANIFEST_URL, {}, { retries: 1 });
    await fsp.mkdir(P.versions, { recursive: true });
    await fsp.writeFile(cache, JSON.stringify(m));
    return { ...m, offline: false };
  } catch (e) {
    try {
      const m = JSON.parse(await fsp.readFile(cache, 'utf8'));
      return { ...m, offline: true };
    } catch (_) {
      throw new Error(`Не удалось получить список версий: ${http.friendlyNetworkError(e)}`);
    }
  }
}

/** Тип загрузчика профиля по его id: 'fabric' | 'quilt' | 'forge' | 'neoforge' | null. */
function loaderFromId(id, json) {
  const s = String(id);
  if (s.startsWith('fabric-loader-')) return 'fabric';
  if (s.startsWith('quilt-loader-')) return 'quilt';
  if (json && json.inheritsFrom) {
    if (/neoforge/i.test(s)) return 'neoforge';
    if (/forge/i.test(s)) return 'forge';
  }
  return null;
}

async function listInstalled(root) {
  const P = gamePaths(root);
  let entries = [];
  try { entries = await fsp.readdir(P.versions, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const j = JSON.parse(await fsp.readFile(path.join(P.versions, e.name, `${e.name}.json`), 'utf8'));
      out.push({
        id: e.name,
        type: j.type || 'custom',
        inheritsFrom: j.inheritsFrom || null,
        loader: loaderFromId(e.name, j),
        mc: j.inheritsFrom || e.name,
        releaseTime: j.releaseTime || null,
      });
    } catch (_) { /* папка без валидного JSON — пропускаем */ }
  }
  out.sort((a, b) => String(b.releaseTime || '').localeCompare(String(a.releaseTime || '')));
  return out;
}

async function readVersionJson(root, id) {
  const P = gamePaths(root);
  return JSON.parse(await fsp.readFile(P.versionJson(id), 'utf8'));
}

/** Скачивает JSON версии (и родительских) при отсутствии. */
async function ensureVersionJson(root, id, { manifest, signal } = {}, depth = 0) {
  if (depth > 5) throw new Error('Слишком глубокая цепочка inheritsFrom');
  const P = gamePaths(root);
  const file = P.versionJson(id);
  let json = null;
  if (await http.fileOk(file)) {
    try { json = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { json = null; } // битый файл — скачаем заново
  }
  if (!json) {
    const m = manifest || await fetchManifest(root);
    const entry = (m.versions || []).find((x) => x.id === id);
    if (!entry) throw new Error(`Версия ${id} не найдена в манифесте Mojang`);
    await http.downloadFile(entry.url, file, { sha1: entry.sha1, signal });
    json = JSON.parse(await fsp.readFile(file, 'utf8'));
  }
  if (json.inheritsFrom) await ensureVersionJson(root, json.inheritsFrom, { manifest, signal }, depth + 1);
  return json;
}

const libKey = (lib) => {
  const [g, a, , cls] = String(lib.name || '').split(':');
  return `${g}:${a}${cls ? `:${cls}` : ''}`;
};

/** Итоговое описание версии: дочерняя поверх родительской. _jarId — id версии, чей jar используется. */
async function resolveVersion(root, id, depth = 0) {
  if (depth > 5) throw new Error('Слишком глубокая цепочка inheritsFrom');
  const v = await readVersionJson(root, id);
  if (!v.inheritsFrom) return { ...v, id, _jarId: v.jar || id };

  const parent = await resolveVersion(root, v.inheritsFrom, depth + 1);
  const merged = { ...parent, ...v, id };
  const seen = new Set();
  merged.libraries = [...(v.libraries || []), ...(parent.libraries || [])].filter((l) => {
    const k = libKey(l);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (parent.arguments || v.arguments) {
    merged.arguments = {
      game: [...((parent.arguments && parent.arguments.game) || []), ...((v.arguments && v.arguments.game) || [])],
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((v.arguments && v.arguments.jvm) || [])],
    };
  }
  merged._jarId = v.jar || parent._jarId;
  return merged;
}

/** Удаляет папку профиля instances/<id> (миры, моды, настройки). */
async function removeInstance(root, id) {
  await fsp.rm(gamePaths(root).instance(id), { recursive: true, force: true });
}

async function removeVersion(root, id) {
  const P = gamePaths(root);
  await fsp.rm(P.versionDir(id), { recursive: true, force: true });
}

module.exports = {
  MANIFEST_URL, fetchManifest, listInstalled, loaderFromId, readVersionJson,
  ensureVersionJson, resolveVersion, removeVersion, removeInstance,
};
