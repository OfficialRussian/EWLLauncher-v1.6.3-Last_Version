'use strict';
/**
 * Маркет модов: поиск и установка модов в папку mods выбранной сборки.
 * Источники описаны в SOURCES. Сейчас работает Modrinth (открытый API, без ключа): он хранит моды для Fabric, Quilt,
 * Forge и NeoForge. У Forge нет собственного каталога, его моды лежат на Modrinth и CurseForge; CurseForge требует
 * личный API-ключ, поэтому пока не подключён (добавить источник = добавить запись в SOURCES).
 * Подбор версии мода идёт по версии Minecraft и загрузчику профиля, обязательные зависимости ставятся автоматически,
 * все файлы проверяются по SHA-1. Всё, что поставил маркет, записано в mods/.ewl-market.json.
 */
const fsp = require('fs').promises;
const path = require('path');
const http = require('../core/http');
const { gamePaths } = require('../core/paths');
const { describe } = require('./../minecraft/loaders');
const { buildPlan, safeFileName, loadersFor } = require('./../minecraft/optimize');
const curseforge = require('./curseforge');

const API = 'https://api.modrinth.com/v2';
const MANIFEST = '.ewl-market.json';
const SORTS = { relevance: 'relevance', downloads: 'downloads', updated: 'updated', newest: 'newest', follows: 'follows' };

const SOURCES = {
  modrinth: { id: 'modrinth', label: 'Modrinth', available: true, note: 'Моды для Fabric, Quilt, Forge и NeoForge. Бесплатно, без ключа.' },
  curseforge: { id: 'curseforge', label: 'CurseForge', available: false, note: 'Каталог CurseForge. Нужен личный API-ключ (Настройки → CurseForge).' },
};

const MODDABLE = ['fabric', 'quilt', 'forge', 'neoforge'];

const mods = (root, versionId) => path.join(gamePaths(root).instance(versionId), 'mods');

async function readManifest(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), 'utf8')); } catch (_) { return { mods: [] }; }
}

/** Фасеты поиска Modrinth: тип «мод», версия игры, загрузчик (внутри группы — «или»), клиентская сторона. */
function buildFacets({ mc, kind }) {
  const facets = [['project_type:mod'], [`versions:${mc}`], loadersFor(kind).map((l) => `categories:${l}`), ['client_side:required', 'client_side:optional']];
  return JSON.stringify(facets);
}

/** Поиск модов, подходящих профилю. Возвращает { hits[], total, offset }. */
async function search({ source = 'modrinth', query = '', mc, kind, sort = 'relevance', offset = 0, limit = 20, signal, curseforgeKey = '' }) {
  if (source === 'curseforge') return curseforge.search({ key: curseforgeKey, query, mc, kind, sort, offset, limit, signal });
  if (!SOURCES[source] || !SOURCES[source].available) throw new Error(`Источник «${source}» пока недоступен.`);
  if (!MODDABLE.includes(kind)) throw new Error('Моды можно ставить только в профили Fabric, Quilt, Forge и NeoForge.');
  if (!mc) throw new Error('Не определена версия Minecraft профиля.');
  const q = new URLSearchParams({
    query: String(query || '').slice(0, 80),
    facets: buildFacets({ mc, kind }),
    index: SORTS[sort] || 'relevance',
    offset: String(Math.max(0, Math.min(1000, Math.floor(Number(offset)) || 0))),
    limit: String(Math.max(1, Math.min(40, Math.floor(Number(limit)) || 20))),
  });
  const r = await http.getJson(`${API}/search?${q}`, { signal }, { retries: 2 });
  return {
    total: r.total_hits || 0,
    offset: r.offset || 0,
    hits: (r.hits || []).map((x) => ({
      id: x.project_id, slug: x.slug, title: x.title, author: x.author, description: x.description,
      downloads: x.downloads || 0, icon: /^https:\/\/cdn\.modrinth\.com\//.test(x.icon_url || '') ? x.icon_url : '',
      categories: (x.display_categories || x.categories || []).slice(0, 4), updated: x.date_modified || '',
    })),
  };
}

/** Что установлено в mods профиля: все jar-файлы с пометками (маркет / библиотека / оптимизация). */
async function listInstalled({ root, versionId }) {
  const dir = mods(root, versionId);
  let names = [];
  try { names = await fsp.readdir(dir); } catch (_) { return []; }
  const market = await readManifest(dir);
  const extra = {};
  for (const [file, tag] of [['.ewl-libs.json', 'Библиотека'], ['.ewl-optimize.json', 'Оптимизация']]) {
    try { for (const m of JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8')).mods || []) extra[m.filename] = tag; } catch (_) { /* нет манифеста */ }
  }
  const byFile = new Map((market.mods || []).map((m) => [m.filename, m]));
  const out = [];
  for (const n of names) {
    if (!/\.jar$/i.test(n)) continue;
    let size = 0;
    try { size = (await fsp.stat(path.join(dir, n))).size; } catch (_) { /* исчез */ }
    const m = byFile.get(n);
    out.push({
      filename: n, size, title: m ? m.title : '', projectId: m ? m.projectId : '', version: m ? m.version : '',
      dependency: !!(m && m.dependency), hasPrevious: !!(m && m.previous), tag: m ? (m.dependency ? 'Зависимость' : 'Маркет') : (extra[n] || ''),
    });
  }
  out.sort((a, b) => (a.title || a.filename).toLowerCase().localeCompare((b.title || b.filename).toLowerCase()));
  return out;
}

/**
 * Установка мода с зависимостями в mods сборки. project — id или slug Modrinth.
 * Возвращает { installed: [{title, version, filename, dependency}], skipped: [{name, reason}] }.
 */
async function install({ root, versionId, project, title = '', source = 'modrinth', onProgress = () => {}, signal, curseforgeKey = '' }) {
  const cf = source === 'curseforge';
  if (!cf && (!SOURCES[source] || !SOURCES[source].available)) throw new Error(`Источник «${source}» пока недоступен.`);
  const d = await describe(root, versionId);
  if (!MODDABLE.includes(d.kind)) throw new Error('Моды можно ставить только в профили Fabric, Quilt, Forge и NeoForge.');
  if (!cf && !/^[A-Za-z0-9_-]{2,64}$/.test(String(project || ''))) throw new Error('Некорректный идентификатор мода.');

  onProgress({ text: 'Подбор версии мода…', fraction: 0.05 });
  const { plan, skipped } = cf
    ? await curseforge.buildPlan({ key: curseforgeKey, modId: project, mc: d.mc, kind: d.kind, signal })
    : await buildPlan({ mc: d.mc, kind: d.kind, slugs: [project], signal });
  if (!plan.length) throw new Error(`Для Minecraft ${d.mc} (${d.kind}) у этого мода нет подходящей версии.`);

  const dir = mods(root, versionId);
  await fsp.mkdir(dir, { recursive: true });
  const prev = await readManifest(dir);
  const existing = new Set((await fsp.readdir(dir)).filter((f) => /\.jar$/i.test(f)));

  const done = [];
  const skip = [...skipped];
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    const isRoot = i === 0 || item.slug === project;
    if (existing.has(item.file.filename)) { skip.push({ name: item.name, reason: 'уже установлен' }); continue; }
    onProgress({ text: `Загрузка: ${item.name}`, fraction: 0.1 + 0.85 * (i / plan.length) });
    await http.downloadFile(item.file.url, path.join(dir, safeFileName(item.file.filename)), { sha1: item.file.sha1, size: item.file.size, signal });
    done.push({ projectId: String(item.slug), slug: item.slug, title: isRoot && title ? String(title).slice(0, 80) : item.name, version: item.versionNumber, filename: item.file.filename, dependency: !isRoot, source, at: new Date().toISOString() });
  }
  // Первым в плане идёт сам мод (название — из поиска), дальше его обязательные зависимости.
  const merged = [...(prev.mods || []).filter((m) => !done.some((x) => x.filename === m.filename)), ...done];
  await fsp.writeFile(path.join(dir, MANIFEST), JSON.stringify({ mods: merged }, null, 2));
  onProgress({ text: 'Мод установлен', fraction: 1 });
  return { installed: done.map((m) => ({ title: m.title, version: m.version, filename: m.filename, dependency: m.dependency })), skipped: skip };
}

/** Удаляет мод из папки mods (только .jar без путей). */
async function remove({ root, versionId, filename }) {
  const name = safeFileName(filename);
  const dir = mods(root, versionId);
  await fsp.rm(path.join(dir, name), { force: true });
  const mf = await readManifest(dir);
  mf.mods = (mf.mods || []).filter((m) => m.filename !== name);
  await fsp.writeFile(path.join(dir, MANIFEST), JSON.stringify(mf, null, 2));
}

// ---------- обновления ----------
const backupDir = (root, versionId) => path.join(gamePaths(root).instance(versionId), 'mods-backup');

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  }));
}

/** Проверка обновлений для модов, поставленных через маркет. Возвращает [{projectId, title, current, next, filename}]. */
async function checkUpdates({ root, versionId, signal }) {
  const d = await describe(root, versionId);
  if (!MODDABLE.includes(d.kind)) throw new Error('Обновление доступно только для сборок с загрузчиком.');
  const mf = await readManifest(mods(root, versionId));
  const list = (mf.mods || []).filter((m) => m.projectId && (!m.source || m.source === 'modrinth')).slice(0, 80); // обновление пока только для Modrinth
  const out = [];
  await pool(list, 4, async (m) => {
    try {
      const { plan } = await buildPlan({ mc: d.mc, kind: d.kind, slugs: [m.projectId], signal });
      const head = plan.find((x) => String(x.slug) === String(m.projectId)) || plan[0];
      if (head && head.file.filename !== m.filename) out.push({ projectId: m.projectId, title: m.title || m.projectId, current: m.version || m.filename, next: head.versionNumber, filename: m.filename });
    } catch (e) {
      if (http.isAbort(e)) throw e;
      /* нет сети или версии для этого мода — просто не предлагаем обновление */
    }
  });
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Обновляет выбранные моды (projects — id проектов). Старый jar не удаляется насовсем, а уходит в instances/<id>/mods-backup,
 * откуда его можно вернуть через rollback.
 */
async function update({ root, versionId, projects, onProgress = () => {}, signal }) {
  const dir = mods(root, versionId);
  const bdir = backupDir(root, versionId);
  const updated = [];
  const failed = [];
  for (let i = 0; i < projects.length; i++) {
    const pid = String(projects[i]);
    const before = (await readManifest(dir)).mods.find((m) => String(m.projectId) === pid);
    if (!before) continue;
    onProgress({ text: `Обновление: ${before.title || pid}`, fraction: i / projects.length });
    try {
      await install({ root, versionId, project: pid, title: before.title, source: before.source || 'modrinth', signal });
      const mf = await readManifest(dir);
      const now = mf.mods.filter((m) => String(m.projectId) === pid);
      const fresh = now.find((m) => m.filename !== before.filename);
      if (!fresh) continue;
      // Старые файлы (этого мода и обновлённых заодно зависимостей) убираем из mods, иначе будет дубликат.
      const keep = [];
      await fsp.mkdir(bdir, { recursive: true });
      for (const m of mf.mods) {
        const newer = mf.mods.some((x) => x !== m && String(x.projectId) === String(m.projectId) && Date.parse(x.at || 0) > Date.parse(m.at || 0));
        if (newer && m.projectId) {
          const from = path.join(dir, m.filename);
          try { await fsp.rename(from, path.join(bdir, m.filename)); } catch (_) { /* уже нет */ }
          if (String(m.projectId) === pid) fresh.previous = { filename: m.filename, version: m.version };
        } else keep.push(m);
      }
      await fsp.writeFile(path.join(dir, MANIFEST), JSON.stringify({ mods: keep }, null, 2));
      updated.push({ title: fresh.title, from: before.version, to: fresh.version });
    } catch (e) {
      if (http.isAbort(e)) throw e;
      failed.push({ title: before.title || pid, reason: e.message });
    }
  }
  onProgress({ text: 'Готово', fraction: 1 });
  return { updated, failed };
}

/** Возвращает прошлую версию мода из mods-backup и убирает обновлённый файл. */
async function rollback({ root, versionId, projectId }) {
  const dir = mods(root, versionId);
  const mf = await readManifest(dir);
  const cur = (mf.mods || []).find((m) => String(m.projectId) === String(projectId) && m.previous);
  if (!cur) throw new Error('Для этого мода нет сохранённой прошлой версии.');
  const prevName = safeFileName(cur.previous.filename);
  const backup = path.join(backupDir(root, versionId), prevName);
  try { await fsp.access(backup); } catch (_) { throw new Error('Файл прошлой версии не найден в mods-backup.'); }
  await fsp.rename(backup, path.join(dir, prevName));
  await fsp.rm(path.join(dir, cur.filename), { force: true });
  const restored = { ...cur, filename: prevName, version: cur.previous.version };
  delete restored.previous;
  mf.mods = mf.mods.map((m) => (m === cur ? restored : m));
  await fsp.writeFile(path.join(dir, MANIFEST), JSON.stringify(mf, null, 2));
  return { title: cur.title, version: restored.version };
}

// ---------- ресурспаки и шейдеры ----------
const CONTENT = {
  resourcepack: { label: 'Ресурспак', dir: 'resourcepacks', ext: /\.zip$/i },
  shader: { label: 'Шейдер', dir: 'shaderpacks', ext: /\.zip$/i },
};
const contentDir = (root, versionId, type) => path.join(gamePaths(root).instance(versionId), CONTENT[type].dir);
function safeContentName(name) {
  const n = String(name || '');
  if (!/^[\p{L}\p{N}._+()\[\], '\-]{1,150}\.zip$/iu.test(n) || n.includes('..')) throw new Error(`Небезопасное имя файла: ${n.slice(0, 60)}`);
  return n;
}
const okType = (t) => { if (!CONTENT[t]) throw new Error('Неизвестный тип контента.'); return t; };

async function searchContent({ type, query = '', mc, sort = 'relevance', offset = 0, limit = 20, signal }) {
  okType(type);
  if (!mc) throw new Error('Не определена версия Minecraft профиля.');
  const q = new URLSearchParams({
    query: String(query || '').slice(0, 80),
    facets: JSON.stringify([[`project_type:${type}`], [`versions:${mc}`]]),
    index: SORTS[sort] || 'relevance',
    offset: String(Math.max(0, Math.min(1000, Math.floor(Number(offset)) || 0))),
    limit: String(Math.max(1, Math.min(40, Math.floor(Number(limit)) || 20))),
  });
  const r = await http.getJson(`${API}/search?${q}`, { signal }, { retries: 2 });
  return {
    total: r.total_hits || 0, offset: r.offset || 0,
    hits: (r.hits || []).map((x) => ({
      id: x.project_id, slug: x.slug, title: x.title, author: x.author, description: x.description, downloads: x.downloads || 0,
      icon: /^https:\/\/cdn\.modrinth\.com\//.test(x.icon_url || '') ? x.icon_url : '',
      categories: (x.display_categories || x.categories || []).slice(0, 4), updated: x.date_modified || '',
    })),
  };
}

async function installContent({ root, versionId, project, type, title = '', onProgress = () => {}, signal }) {
  okType(type);
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(String(project || ''))) throw new Error('Некорректный идентификатор.');
  const d = await describe(root, versionId);
  onProgress({ text: 'Подбор версии…', fraction: 0.1 });
  const q = new URLSearchParams({ game_versions: JSON.stringify([d.mc]) });
  const list = await http.getJson(`${API}/project/${encodeURIComponent(project)}/version?${q}`, { signal }, { retries: 2 });
  const ver = (list || []).find((v) => v.version_type === 'release') || (list || [])[0];
  const file = ver && ((ver.files || []).find((f) => f.primary) || (ver.files || [])[0]);
  if (!file) throw new Error(`Для Minecraft ${d.mc} нет подходящей версии.`);
  const name = safeContentName(file.filename);
  if (!CONTENT[type].ext.test(name)) throw new Error('Файл не является .zip-архивом, лаунчер его не ставит.');
  const dir = contentDir(root, versionId, type);
  await fsp.mkdir(dir, { recursive: true });
  onProgress({ text: `Загрузка: ${title || name}`, fraction: 0.3 });
  await http.downloadFile(file.url, path.join(dir, name), { sha1: file.hashes && file.hashes.sha1, size: file.size, signal });
  onProgress({ text: 'Установлено', fraction: 1 });
  return { filename: name, version: ver.version_number, title: title || name };
}

async function listContent({ root, versionId, type }) {
  okType(type);
  const dir = contentDir(root, versionId, type);
  let names = [];
  try { names = await fsp.readdir(dir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!CONTENT[type].ext.test(n)) continue;
    try { out.push({ filename: n, size: (await fsp.stat(path.join(dir, n))).size }); } catch (_) { /* исчез */ }
  }
  return out.sort((a, b) => a.filename.localeCompare(b.filename));
}

async function removeContent({ root, versionId, type, filename }) {
  okType(type);
  await fsp.rm(path.join(contentDir(root, versionId, type), safeContentName(filename)), { force: true });
}

module.exports = { SOURCES, MODDABLE, CONTENT, buildFacets, search, listInstalled, install, remove, checkUpdates, update, rollback, searchContent, installContent, listContent, removeContent };
