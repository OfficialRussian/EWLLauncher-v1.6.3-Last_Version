'use strict';
/**
 * Оптимизация: моды производительности с Modrinth для профилей Fabric/Quilt.
 * Скачиваются в <папка игры>/instances/<профиль>/mods с проверкой SHA-1.
 * Файлы, поставленные лаунчером, записаны в mods/.ewl-optimize.json — только их он обновляет и удаляет.
 */
const fsp = require('fs').promises;
const path = require('path');
const http = require('../core/http');
const { gamePaths } = require('../core/paths');
const { describe } = require('./loaders');

const API = 'https://api.modrinth.com/v2';
const MANIFEST = '.ewl-optimize.json';
const LIBS_MANIFEST = '.ewl-libs.json'; // библиотеки (Fabric API и др.): их оптимизация не трогает и не удаляет

const MODS = [
  { slug: 'sodium', name: 'Sodium', desc: 'Новый движок отрисовки — главный прирост FPS' },
  { slug: 'lithium', name: 'Lithium', desc: 'Быстрее игровая логика, мобы и генерация мира' },
  { slug: 'ferrite-core', name: 'FerriteCore', desc: 'Заметно меньше потребление оперативной памяти' },
  { slug: 'immediatelyfast', name: 'ImmediatelyFast', desc: 'Быстрее интерфейс, текст и отрисовка' },
  { slug: 'entityculling', name: 'Entity Culling', desc: 'Не рисует сущности, скрытые за стенами' },
  { slug: 'modernfix', name: 'ModernFix', desc: 'Быстрый запуск игры и меньше лагов' },
];
const DEFAULT_SLUGS = MODS.map((m) => m.slug);
const nameOf = (slug) => (MODS.find((m) => m.slug === slug) || { name: slug }).name;

const isJar = (f) => f && /\.jar$/i.test(f.filename || '');

/** Лучшая версия мода: сначала релизы, потом беты; внутри — самая свежая. */
function pickVersion(list) {
  const rank = (t) => (t === 'release' ? 0 : t === 'beta' ? 1 : 2);
  const ok = (list || []).filter((v) => v && Array.isArray(v.files) && v.files.some(isJar));
  ok.sort((a, b) => rank(a.version_type) - rank(b.version_type)
    || String(b.date_published).localeCompare(String(a.date_published)));
  return ok[0] || null;
}

function pickFile(version) {
  return version.files.find((f) => f.primary && isJar(f)) || version.files.find(isJar);
}

/** Имя файла из внешнего источника: только безопасные символы, без путей. */
function safeFileName(name) {
  const n = String(name || '');
  if (!/^[A-Za-z0-9._+()\- ]{1,150}\.jar$/i.test(n) || n.includes('..')) throw new Error(`Небезопасное имя файла мода: ${n.slice(0, 60)}`);
  return n;
}

const versionsUrl = (project, mc, loaders) => `${API}/project/${encodeURIComponent(project)}/version`
  + `?loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([mc]))}`;

/** Загрузчики Modrinth, чьи моды подходят профилю (Quilt запускает и моды Fabric). */
const loadersFor = (kind) => (kind === 'quilt' ? ['quilt', 'fabric'] : kind === 'forge' ? ['forge'] : kind === 'neoforge' ? ['neoforge'] : ['fabric']);

/** Составляет список загрузки вместе с обязательными зависимостями (до 2 уровней). */
async function buildPlan({ mc, kind, slugs, signal }) {
  const plan = new Map();
  const skipped = [];
  const queue = slugs.map((s) => ({ ref: s, depth: 0 }));
  const loaders = loadersFor(kind);
  while (queue.length) {
    const q = queue.shift();
    let ver = null;
    try {
      ver = q.versionId
        ? await http.getJson(`${API}/version/${encodeURIComponent(q.versionId)}`, { signal }, { retries: 2 })
        : pickVersion(await http.getJson(versionsUrl(q.ref, mc, loaders), { signal }, { retries: 2 }));
    } catch (e) {
      if (http.isAbort(e)) throw e;
      if (e instanceof http.HttpError && e.status === 404) ver = null; else throw e;
    }
    const file = ver && Array.isArray(ver.files) ? pickFile(ver) : null;
    if (!ver || !file) {
      if (q.depth === 0) skipped.push({ slug: q.ref, name: nameOf(q.ref), reason: `нет версии для Minecraft ${mc}` });
      continue;
    }
    if (plan.has(ver.project_id)) continue;
    plan.set(ver.project_id, {
      slug: q.depth === 0 ? q.ref : String(ver.project_id),
      name: q.depth === 0 ? nameOf(q.ref) : (ver.name || q.ref),
      versionNumber: ver.version_number || '',
      file: { url: file.url, filename: safeFileName(file.filename), sha1: file.hashes && file.hashes.sha1, size: file.size },
    });
    if (q.depth < 2) {
      for (const d of ver.dependencies || []) {
        if (d.dependency_type !== 'required') continue;
        if (d.version_id) queue.push({ versionId: d.version_id, ref: d.project_id || d.version_id, depth: q.depth + 1 });
        else if (d.project_id) queue.push({ ref: d.project_id, depth: q.depth + 1 });
      }
    }
  }
  return { plan: [...plan.values()], skipped };
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return null; }
}

async function readManifest(modsDir) {
  try { return JSON.parse(await fsp.readFile(path.join(modsDir, MANIFEST), 'utf8')); } catch (_) { return { mods: [] }; }
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Моды производительности ставятся только на Fabric/Quilt (Forge — другой набор модов). */
const moddable = (d) => d.kind === 'fabric' || d.kind === 'quilt';

async function status(root, versionId) {
  const d = await describe(root, versionId);
  const P = gamePaths(root);
  const modsDir = path.join(P.instance(versionId), 'mods');
  const mf = moddable(d) ? await readManifest(modsDir) : { mods: [] };
  const installed = [];
  for (const m of mf.mods || []) {
    try { await fsp.access(path.join(modsDir, m.filename)); installed.push(m); } catch (_) { /* файл удалён вручную */ }
  }
  const type = d.json && d.json.type;
  return {
    kind: d.kind,
    mc: d.mc,
    supported: moddable(d),
    canCreateProfile: !d.kind && !(d.json && d.json.inheritsFrom) && type === 'release',
    installed: installed.length > 0,
    mods: installed.map((m) => ({ name: m.name, version: m.versionNumber })),
    available: MODS,
  };
}

async function installMods({ root, versionId, slugs = DEFAULT_SLUGS, onProgress = () => {}, signal }) {
  const d = await describe(root, versionId);
  if (!moddable(d)) throw new Error('Моды производительности ставятся только на профили Fabric или Quilt.');
  const chosen = slugs.filter((s) => DEFAULT_SLUGS.includes(s));
  if (!chosen.length) throw new Error('Не выбрано ни одного мода.');

  onProgress({ text: 'Поиск модов на Modrinth…', fraction: 0.02 });
  const { plan, skipped } = await buildPlan({ mc: d.mc, kind: d.kind, slugs: chosen, signal });
  if (!plan.length) throw new Error(`Для Minecraft ${d.mc} пока нет подходящих модов оптимизации.`);

  const modsDir = path.join(gamePaths(root).instance(versionId), 'mods');
  await fsp.mkdir(modsDir, { recursive: true });
  const prev = await readManifest(modsDir);
  const existing = (await fsp.readdir(modsDir)).filter((f) => /\.jar$/i.test(f));
  const managed = new Set((prev.mods || []).map((m) => m.filename));
  const libMf = await readJson(path.join(modsDir, LIBS_MANIFEST));
  const libFiles = new Set(((libMf && libMf.mods) || []).map((m) => m.filename));
  const foreign = existing.filter((f) => !managed.has(f));

  const todo = [];
  for (const item of plan) {
    // Мод уже положен пользователем вручную — не дублируем (двойные копии ломают запуск).
    if (libFiles.has(item.file.filename)) continue; // уже стоит как библиотека (например Fabric API)
    const dup = foreign.find((f) => norm(f).startsWith(norm(item.slug)) || norm(f).startsWith(norm(item.name)));
    if (dup) { skipped.push({ slug: item.slug, name: item.name, reason: `уже есть файл ${dup}` }); continue; }
    todo.push(item);
  }

  let done = 0;
  const installedNow = [];
  for (const item of todo) {
    onProgress({ text: `Загрузка: ${item.name}`, fraction: 0.1 + 0.85 * (done / todo.length) });
    await http.downloadFile(item.file.url, path.join(modsDir, item.file.filename), { sha1: item.file.sha1, size: item.file.size, signal });
    installedNow.push({ slug: item.slug, name: item.name, versionNumber: item.versionNumber, filename: item.file.filename });
    done++;
  }

  // Убираем свои устаревшие файлы (старые версии тех же модов).
  const keep = new Set(installedNow.map((m) => m.filename));
  for (const m of prev.mods || []) {
    if (!keep.has(m.filename)) await fsp.rm(path.join(modsDir, m.filename), { force: true }).catch(() => {});
  }
  await fsp.writeFile(path.join(modsDir, MANIFEST), JSON.stringify({ mods: installedNow, at: new Date().toISOString() }, null, 2));
  onProgress({ text: 'Оптимизация установлена', fraction: 1 });
  return { installed: installedNow.map((m) => ({ name: m.name, version: m.versionNumber })), skipped };
}

async function removeMods(root, versionId) {
  const modsDir = path.join(gamePaths(root).instance(versionId), 'mods');
  const mf = await readManifest(modsDir);
  for (const m of mf.mods || []) await fsp.rm(path.join(modsDir, safeFileName(m.filename)), { force: true }).catch(() => {});
  await fsp.rm(path.join(modsDir, MANIFEST), { force: true }).catch(() => {});
}

module.exports = { LIBS_MANIFEST, loadersFor, norm, MODS, DEFAULT_SLUGS, pickVersion, pickFile, safeFileName, buildPlan, status, installMods, removeMods };
