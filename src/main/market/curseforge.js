'use strict';
/**
 * CurseForge API v1 (нужен личный ключ, он хранится в настройках лаунчера и никогда не попадает в код).
 * Поиск модов под версию игры и загрузчик, подбор файла и обязательных зависимостей.
 * Скачивание — только с *.forgecdn.net; если автор мода запретил загрузку вне CurseForge, downloadUrl пустой, и мод пропускается.
 */
const http = require('../core/http');

const API = 'https://api.curseforge.com/v1';
const GAME_ID = 432; // Minecraft
const CLASS_MODS = 6;
const LOADER_TYPE = { forge: 1, fabric: 4, quilt: 4, neoforge: 6 }; // Quilt запускает моды Fabric
const SORT = { relevance: 1, downloads: 6, updated: 3, newest: 11 };
const MAX_DEPS = 15;
const hooks = { allowHost: null }; // только для тестов

const KEY_RE = /^[A-Za-z0-9$./_-]{20,100}$/;
const validKey = (k) => KEY_RE.test(String(k || ''));

const hostAllowed = (u) => {
  if (hooks.allowHost) return hooks.allowHost(u);
  try { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === 'forgecdn.net' || x.hostname.endsWith('.forgecdn.net')); } catch (_) { return false; }
};

async function api(key, pathAndQuery, signal) {
  if (!validKey(key)) throw new Error('Не указан ключ CurseForge: впишите его в Настройки → CurseForge.');
  try {
    return await http.getJson(`${API}${pathAndQuery}`, { signal, headers: { 'x-api-key': key, Accept: 'application/json' } }, { retries: 2 });
  } catch (e) {
    if (e && (e.status === 401 || e.status === 403)) throw new Error('CurseForge отклонил ключ. Проверьте его в Настройках.');
    throw e;
  }
}

async function search({ key, query = '', mc, kind, sort = 'relevance', offset = 0, limit = 20, signal }) {
  if (!LOADER_TYPE[kind]) throw new Error('Моды можно ставить только в профили Fabric, Quilt, Forge и NeoForge.');
  if (!mc) throw new Error('Не определена версия Minecraft профиля.');
  const q = new URLSearchParams({
    gameId: String(GAME_ID), classId: String(CLASS_MODS), searchFilter: String(query || '').slice(0, 80),
    gameVersion: String(mc), modLoaderType: String(LOADER_TYPE[kind]),
    sortField: String(SORT[sort] || 1), sortOrder: 'desc',
    index: String(Math.max(0, Math.min(9000, Math.floor(Number(offset)) || 0))),
    pageSize: String(Math.max(1, Math.min(40, Math.floor(Number(limit)) || 20))),
  });
  const r = await api(key, `/mods/search?${q}`, signal);
  return {
    total: (r.pagination && r.pagination.totalCount) || 0,
    offset: (r.pagination && r.pagination.index) || 0,
    hits: (r.data || []).map((x) => ({
      id: String(x.id), slug: x.slug, title: x.name, author: ((x.authors || [])[0] || {}).name || '', description: x.summary || '',
      downloads: Math.round(x.downloadCount || 0),
      icon: x.logo && x.logo.thumbnailUrl && hostAllowed(x.logo.thumbnailUrl) ? x.logo.thumbnailUrl : '',
      categories: (x.categories || []).slice(0, 4).map((c) => c.name), updated: x.dateModified || '',
    })),
  };
}

const sha1Of = (f) => ((f.hashes || []).find((h) => h.algo === 1) || {}).value || '';

/** Лучший файл мода: свежий релиз, иначе бета/альфа. */
async function pickFile({ key, modId, mc, kind, signal }) {
  const q = new URLSearchParams({ gameVersion: String(mc), modLoaderType: String(LOADER_TYPE[kind]), pageSize: '30' });
  const r = await api(key, `/mods/${encodeURIComponent(modId)}/files?${q}`, signal);
  const files = (r.data || []).filter((f) => f.fileName && /\.jar$/i.test(f.fileName)).sort((a, b) => Date.parse(b.fileDate || 0) - Date.parse(a.fileDate || 0));
  return files.find((f) => f.releaseType === 1) || files[0] || null;
}

/** План установки: сам мод и его обязательные зависимости. Возвращает { plan, skipped }. */
async function buildPlan({ key, modId, mc, kind, signal }) {
  if (!/^\d{1,10}$/.test(String(modId))) throw new Error('Некорректный идентификатор мода.');
  if (!LOADER_TYPE[kind]) throw new Error('Моды можно ставить только в профили Fabric, Quilt, Forge и NeoForge.');
  const plan = []; const skipped = []; const seen = new Set();
  const queue = [String(modId)];
  while (queue.length && plan.length < MAX_DEPS) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    let name = id;
    try {
      const meta = await api(key, `/mods/${encodeURIComponent(id)}`, signal);
      name = (meta.data && meta.data.name) || id;
    } catch (e) { if (http.isAbort(e)) throw e; }
    const file = await pickFile({ key, modId: id, mc, kind, signal });
    if (!file) { skipped.push({ name, reason: `нет версии для Minecraft ${mc}` }); continue; }
    if (!file.downloadUrl || !hostAllowed(file.downloadUrl)) { skipped.push({ name, reason: 'автор запретил скачивание вне сайта CurseForge' }); continue; }
    plan.push({
      slug: id, name, versionNumber: file.displayName || file.fileName,
      file: { url: file.downloadUrl, filename: file.fileName, sha1: sha1Of(file), size: file.fileLength },
    });
    for (const d of file.dependencies || []) if (d.relationType === 3) queue.push(String(d.modId));
  }
  return { plan, skipped };
}

module.exports = { search, buildPlan, validKey, hooks, LOADER_TYPE };
