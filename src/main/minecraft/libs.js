'use strict';
/**
 * Обязательные библиотеки загрузчиков: Fabric API для Fabric, Quilted Fabric API (с QSL) для Quilt.
 * Большинство модов без них не запускается, поэтому лаунчер ставит их вместе с загрузчиком.
 * Файлы скачиваются с Modrinth (проверка SHA-1) в mods/ профиля и записываются в mods/.ewl-libs.json —
 * «Оптимизация» эти файлы не удаляет.
 */
const fsp = require('fs').promises;
const path = require('path');
const http = require('../core/http');
const { gamePaths } = require('../core/paths');
const { describe } = require('./loaders');
const { buildPlan, LIBS_MANIFEST } = require('./optimize');

/** Варианты по порядку: берётся первый, у которого есть версия для данной версии Minecraft. */
const LIBS = {
  fabric: { title: 'Fabric API', candidates: ['fabric-api'] },
  quilt: { title: 'Quilted Fabric API', candidates: ['qfapi', 'fabric-api'] },
};

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
// Признаки уже стоящей библиотеки по имени файла (в том числе положенной вручную).
const ALREADY = ['fabricapi', 'quiltedfabricapi', 'qfapi', 'quiltstandardlibraries', 'qsl'];

async function readManifest(modsDir) {
  try { return JSON.parse(await fsp.readFile(path.join(modsDir, LIBS_MANIFEST), 'utf8')); } catch (_) { return { mods: [] }; }
}

async function listJars(modsDir) {
  try { return (await fsp.readdir(modsDir)).filter((f) => /\.jar$/i.test(f)); } catch (_) { return []; }
}

/** Состояние библиотек профиля: нужны ли они вообще и стоят ли. */
async function status(root, versionId) {
  const d = await describe(root, versionId);
  const lib = LIBS[d.kind];
  if (!lib) return { supported: false, title: '', present: false };
  const modsDir = path.join(gamePaths(root).instance(versionId), 'mods');
  const jars = (await listJars(modsDir)).map(norm);
  return { supported: true, title: lib.title, present: jars.some((j) => ALREADY.some((a) => j.startsWith(a))) };
}

/**
 * Ставит библиотеку профиля. Возвращает { installed: [{name, version}], skipped: [{name, reason}] }.
 * Ничего не делает для Vanilla/Forge/NeoForge. Если для версии Minecraft библиотеки ещё нет — это не ошибка, а запись в skipped.
 */
async function installLibraries({ root, versionId, onProgress = () => {}, signal }) {
  const d = await describe(root, versionId);
  const lib = LIBS[d.kind];
  if (!lib) return { installed: [], skipped: [] };

  const modsDir = path.join(gamePaths(root).instance(versionId), 'mods');
  await fsp.mkdir(modsDir, { recursive: true });
  const st = await status(root, versionId);
  if (st.present) return { installed: [], skipped: [{ name: lib.title, reason: 'уже установлена' }] };

  onProgress({ text: `Поиск ${lib.title}…`, fraction: 0.05 });
  let plan = [];
  for (const slug of lib.candidates) {
    const r = await buildPlan({ mc: d.mc, kind: d.kind, slugs: [slug], signal });
    if (r.plan.length) { plan = r.plan; break; }
  }
  if (!plan.length) return { installed: [], skipped: [{ name: lib.title, reason: `пока нет версии для Minecraft ${d.mc}` }] };

  const done = [];
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    onProgress({ text: `Загрузка: ${item.name}`, fraction: 0.1 + 0.85 * (i / plan.length) });
    await http.downloadFile(item.file.url, path.join(modsDir, item.file.filename), { sha1: item.file.sha1, size: item.file.size, signal });
    done.push({ name: item.name, versionNumber: item.versionNumber, filename: item.file.filename });
  }
  const prev = await readManifest(modsDir);
  const merged = [...(prev.mods || []).filter((m) => !done.some((x) => x.filename === m.filename)), ...done];
  await fsp.writeFile(path.join(modsDir, LIBS_MANIFEST), JSON.stringify({ mods: merged, at: new Date().toISOString() }, null, 2));
  onProgress({ text: `${lib.title} установлена`, fraction: 1 });
  return { installed: done.map((m) => ({ name: m.name, version: m.versionNumber })), skipped: [] };
}

module.exports = { LIBS, status, installLibraries };
