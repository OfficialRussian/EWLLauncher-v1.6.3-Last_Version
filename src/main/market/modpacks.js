'use strict';
/**
 * Модпаки Modrinth (.mrpack). Поиск, список версий пакета и установка:
 * скачивается .mrpack, ставится нужная версия Minecraft и загрузчик, затем файлы пакета и overrides
 * раскладываются в папку нового профиля. Все файлы проверяются по SHA-1, пути не могут выйти за папку профиля,
 * загрузки разрешены только с известных хостов (как требует спецификация формата).
 */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const http = require('../core/http');
const { gamePaths } = require('../core/paths');
const loaders = require('../minecraft/loaders');
const profiles = require('../profiles/profiles');

const API = 'https://api.modrinth.com/v2';
const SORTS = { relevance: 'relevance', downloads: 'downloads', updated: 'updated', newest: 'newest', follows: 'follows' };
const ALLOWED_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
const LOADER_KEYS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };
const MAX_FILES = 1500;
const MAX_INDEX_BYTES = 5 * 1024 * 1024;

const hooks = { allowHost: null }; // только для тестов

function hostAllowed(u) {
  if (hooks.allowHost) return hooks.allowHost(u);
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch (_) { return false; }
}

async function search({ query = '', mc = '', sort = 'relevance', offset = 0, limit = 20, signal } = {}) {
  const facets = [['project_type:modpack']];
  if (mc) facets.push([`versions:${mc}`]);
  const q = new URLSearchParams({
    query: String(query || '').slice(0, 80),
    facets: JSON.stringify(facets),
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
      versions: (x.versions || []).slice(-1),
    })),
  };
}

const okId = (s) => /^[A-Za-z0-9_-]{2,64}$/.test(String(s || ''));

/** Версии пакета (новые сверху): только те, у которых есть .mrpack. */
async function listVersions(project, { signal } = {}) {
  if (!okId(project)) throw new Error('Некорректный идентификатор модпака.');
  const list = await http.getJson(`${API}/project/${encodeURIComponent(project)}/version`, { signal }, { retries: 2 });
  return (list || []).filter((v) => (v.files || []).some((f) => /\.mrpack$/i.test(f.filename))).slice(0, 40).map((v) => ({
    id: v.id, name: v.name || v.version_number, number: v.version_number,
    mc: (v.game_versions || [])[0] || '', loaders: v.loaders || [], date: v.date_published || '',
    type: v.version_type || 'release',
  }));
}

/** Разбирает modrinth.index.json и проверяет его: версия формата, зависимости, пути файлов и хосты загрузки. */
function parseIndex(index) {
  if (!index || index.formatVersion !== 1 || index.game !== 'minecraft') throw new Error('Неподдерживаемый формат модпака.');
  const deps = index.dependencies || {};
  const mc = String(deps.minecraft || '');
  if (!/^[0-9A-Za-z._-]{1,40}$/.test(mc)) throw new Error('В модпаке не указана версия Minecraft.');
  let kind = null; let loaderVersion = '';
  for (const [key, k] of Object.entries(LOADER_KEYS)) {
    if (deps[key]) { kind = k; loaderVersion = String(deps[key]); break; }
  }
  if (!kind) throw new Error('Модпак без загрузчика модов (Fabric, Quilt, Forge или NeoForge) не поддерживается.');
  const files = [];
  for (const f of (index.files || []).slice(0, MAX_FILES)) {
    const rel = String(f.path || '').replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((p) => p === '..' || p === '')) continue;
    if (f.env && f.env.client === 'unsupported') continue; // серверные моды клиенту не нужны
    const sha1 = f.hashes && f.hashes.sha1;
    const url = (f.downloads || []).find(hostAllowed);
    if (!sha1 || !url) continue;
    files.push({ path: rel, url, sha1, size: Number(f.fileSize) || undefined });
  }
  return { name: String(index.name || 'Модпак').slice(0, 60), mc, kind, loaderVersion, files, skippedFiles: (index.files || []).length - files.length };
}

/** Версия загрузчика из пакета -> строка из списка загрузчиков (Forge/NeoForge иногда с префиксом). */
async function matchLoaderVersion(kind, mc, wanted) {
  try {
    const list = await loaders.listLoaders(kind, mc);
    const hit = list.find((l) => l.version === wanted) || list.find((l) => l.version.endsWith(wanted)) || list.find((l) => wanted.endsWith(l.version));
    if (hit) return hit.version;
  } catch (_) { /* нет сети к метаданным — пробуем как есть */ }
  return wanted;
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

/** Ставит модпак: возвращает { id, name, mc, kind, files, skipped }. */
async function install({ root, project, version, settings, onProgress = () => {}, signal }) {
  if (!okId(project)) throw new Error('Некорректный идентификатор модпака.');
  onProgress({ text: 'Получение информации о модпаке…', fraction: 0.01 });
  let v;
  if (version) {
    if (!okId(version)) throw new Error('Некорректная версия модпака.');
    v = await http.getJson(`${API}/version/${encodeURIComponent(version)}`, { signal }, { retries: 2 });
  } else {
    const list = await http.getJson(`${API}/project/${encodeURIComponent(project)}/version`, { signal }, { retries: 2 });
    v = (list || []).find((x) => (x.files || []).some((f) => /\.mrpack$/i.test(f.filename)));
  }
  const file = v && (v.files || []).find((f) => /\.mrpack$/i.test(f.filename) && f.primary) || (v && (v.files || []).find((f) => /\.mrpack$/i.test(f.filename)));
  if (!file || !hostAllowed(file.url)) throw new Error('У этого модпака нет файла .mrpack.');

  const tmp = path.join(os.tmpdir(), `ewl-${Date.now()}-${Math.random().toString(36).slice(2)}.mrpack`);
  try {
    onProgress({ text: 'Скачивание модпака…', fraction: 0.03 });
    await http.downloadFile(file.url, tmp, { sha1: file.hashes && file.hashes.sha1, signal });
    const zip = new AdmZip(tmp);
    const entry = zip.getEntry('modrinth.index.json');
    if (!entry) throw new Error('В архиве нет modrinth.index.json — это не модпак Modrinth.');
    if (entry.header && entry.header.size > MAX_INDEX_BYTES) throw new Error('Описание модпака слишком большое.');
    const pack = parseIndex(JSON.parse(entry.getData().toString('utf8')));

    const loaderVersion = await matchLoaderVersion(pack.kind, pack.mc, pack.loaderVersion);
    const baseId = await loaders.installLoader(root, pack.kind, pack.mc, loaderVersion, {
      signal, settings,
      onProgress: (p) => onProgress({ text: p.text, fraction: 0.05 + 0.4 * p.fraction }),
    });

    // Если профиль с таким загрузчиком уже есть (с модами), модпак ставится в отдельную копию, ничего не затирая.
    const P = gamePaths(root);
    let id = baseId;
    let busy = false;
    try { busy = (await fsp.readdir(P.instance(baseId))).length > 0; } catch (_) { /* папки ещё нет */ }
    if (busy) {
      id = await profiles.uniqueId(root, baseId);
      await profiles.cloneVersion(root, baseId, id);
    }
    const inst = P.instance(id);
    await fsp.mkdir(inst, { recursive: true });

    let done = 0;
    await pool(pack.files, 4, async (f) => {
      const dest = path.resolve(inst, f.path);
      if (!profiles.inside(inst, dest)) return;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await http.downloadFile(f.url, dest, { sha1: f.sha1, size: f.size, signal });
      done++;
      onProgress({ text: `Загрузка файлов: ${done} из ${pack.files.length}`, fraction: 0.45 + 0.5 * (done / Math.max(1, pack.files.length)) });
    });
    onProgress({ text: 'Копирование настроек пакета…', fraction: 0.96 });
    await profiles.extractPrefix(zip, 'overrides/', inst);
    await profiles.extractPrefix(zip, 'client-overrides/', inst);
    onProgress({ text: 'Модпак установлен', fraction: 1 });
    return { id, name: pack.name, mc: pack.mc, kind: pack.kind, files: pack.files.length, skipped: pack.skippedFiles, copied: busy };
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

module.exports = { search, listVersions, install, parseIndex, hostAllowed, hooks };
