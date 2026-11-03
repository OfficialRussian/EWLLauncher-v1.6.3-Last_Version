'use strict';
/**
 * Операции над сборками (профилями): бэкапы миров, копия, экспорт/импорт в .zip.
 *  - миры:   instances/<id>/saves/<мир>
 *  - бэкапы: <gameDir>/backups/<id>/<id>-<дата>.zip   (внутри saves/<мир>/...)
 *  - экспорт: profile.json + version/<id>.json + instance/<файлы профиля>
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { gamePaths, assertSafeId } = require('../core/paths');

const MAX_ZIP_BYTES = 1500 * 1024 * 1024; // adm-zip собирает архив в памяти — ограничиваем размер
const EXPORT_DIRS = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'datapacks'];
const EXPORT_FILES = ['options.txt', 'servers.dat'];

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const exists = async (p) => { try { await fsp.access(p); return true; } catch (_) { return false; } };
const safeSeg = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100);

async function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch (_) { /* исчез */ } }
  }
  return total;
}

/** Проверка, что путь внутри base (защита от zip-slip). */
function inside(base, target) {
  const rel = path.relative(base, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Распаковывает записи архива с префиксом prefix в destDir. Лишние и опасные пути пропускает. */
async function extractPrefix(zip, prefix, destDir, { filter } = {}) {
  let count = 0;
  for (const e of zip.getEntries()) {
    const name = e.entryName.replace(/\\/g, '/');
    if (!name.startsWith(prefix) || e.isDirectory) continue;
    const rel = name.slice(prefix.length);
    if (!rel || (filter && !filter(rel))) continue;
    const target = path.resolve(destDir, rel);
    if (!inside(destDir, target)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, e.getData());
    count++;
  }
  return count;
}

// ---------- миры и бэкапы ----------

async function listWorlds(root, id) {
  const dir = path.join(gamePaths(root).instance(id), 'saves');
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    let mtime = 0;
    try { mtime = (await fsp.stat(path.join(p, 'level.dat'))).mtimeMs; } catch (_) { try { mtime = (await fsp.stat(p)).mtimeMs; } catch (__) { /* */ } }
    out.push({ name: e.name, size: await dirSize(p), mtime });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const backupDir = (root, id) => path.join(root, 'backups', assertSafeId(id));

async function backupWorlds({ root, id, worlds }) {
  const all = await listWorlds(root, id);
  const pick = all.filter((w) => !worlds || !worlds.length || worlds.includes(w.name));
  if (!pick.length) throw new Error('В этой сборке пока нет миров для копирования.');
  const total = pick.reduce((s, w) => s + w.size, 0);
  if (total > MAX_ZIP_BYTES) throw new Error('Миры слишком большие для одного архива (больше 1,5 ГБ). Выберите меньше миров.');
  const zip = new AdmZip();
  const savesDir = path.join(gamePaths(root).instance(id), 'saves');
  for (const w of pick) zip.addLocalFolder(path.join(savesDir, w.name), `saves/${w.name}`);
  const dir = backupDir(root, id);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeSeg(id)}-${stamp()}.zip`);
  await new Promise((resolve, reject) => zip.writeZip(file, (err) => (err ? reject(err) : resolve())));
  return { file: path.basename(file), worlds: pick.map((w) => w.name), size: (await fsp.stat(file)).size };
}

async function listBackups(root, id) {
  const dir = backupDir(root, id);
  let names = [];
  try { names = await fsp.readdir(dir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.zip')) continue;
    try {
      const st = await fsp.stat(path.join(dir, n));
      out.push({ file: n, size: st.size, mtime: st.mtimeMs });
    } catch (_) { /* пропуск */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function backupPath(root, id, file) {
  const base = path.basename(String(file || ''));
  if (!base || base !== file || !base.toLowerCase().endsWith('.zip')) throw new Error('Некорректное имя бэкапа.');
  return path.join(backupDir(root, id), base);
}

/** Восстановление. Существующий мир с тем же именем не затирается: он переименовывается в «<имя>.до-восстановления-<дата>». */
async function restoreBackup({ root, id, file }) {
  const p = backupPath(root, id, file);
  if (!(await exists(p))) throw new Error('Бэкап не найден.');
  const zip = new AdmZip(p);
  const saves = path.join(gamePaths(root).instance(id), 'saves');
  const names = new Set();
  for (const e of zip.getEntries()) {
    const m = /^saves\/([^/]+)\//.exec(e.entryName.replace(/\\/g, '/'));
    if (m) names.add(m[1]);
  }
  if (!names.size) throw new Error('В архиве нет миров.');
  await fsp.mkdir(saves, { recursive: true });
  const kept = [];
  for (const n of names) {
    const target = path.join(saves, n);
    if (!inside(saves, target)) continue;
    if (await exists(target)) {
      const moved = `${n}.до-восстановления-${stamp()}`;
      await fsp.rename(target, path.join(saves, moved));
      kept.push(moved);
    }
  }
  await extractPrefix(zip, 'saves/', saves);
  return { worlds: [...names], kept };
}

async function removeBackup({ root, id, file }) {
  await fsp.rm(backupPath(root, id, file), { force: true });
}

// ---------- копия сборки ----------

async function uniqueId(root, base) {
  const P = gamePaths(root);
  for (let i = 1; i < 100; i++) {
    const cand = i === 1 ? `${base}-copy` : `${base}-copy${i}`;
    if (!(await exists(P.versionDir(cand))) && !(await exists(P.instance(cand)))) return cand;
  }
  throw new Error('Слишком много копий этой сборки.');
}

/** Копирует файлы версии (json, jar) под новым id. Кэш natives не копируется — пересоберётся при запуске. */
async function cloneVersion(root, id, newId) {
  const P = gamePaths(root);
  const srcDir = P.versionDir(id);
  const dstDir = P.versionDir(newId);
  await fsp.mkdir(dstDir, { recursive: true });
  const json = JSON.parse(await fsp.readFile(P.versionJson(id), 'utf8'));
  json.id = newId;
  await fsp.writeFile(P.versionJson(newId), JSON.stringify(json, null, 2));
  const jar = path.join(srcDir, `${id}.jar`);
  if (await exists(jar)) await fsp.copyFile(jar, P.versionJar(newId));
}

async function duplicate({ root, id, withData = true }) {
  const P = gamePaths(root);
  if (!(await exists(P.versionJson(id)))) throw new Error('Сборка не найдена.');
  const newId = await uniqueId(root, id);
  await cloneVersion(root, id, newId);
  if (withData && (await exists(P.instance(id)))) {
    await fsp.cp(P.instance(id), P.instance(newId), { recursive: true });
  }
  return { id: newId, from: id };
}

// ---------- экспорт / импорт ----------

async function exportProfile({ root, id, file, name, loader, mc, includeWorlds = false, config = null }) {
  const P = gamePaths(root);
  if (!(await exists(P.versionJson(id)))) throw new Error('Сборка не найдена.');
  const inst = P.instance(id);
  let total = 0;
  const parts = [];
  for (const d of EXPORT_DIRS) if (await exists(path.join(inst, d))) parts.push(d);
  if (includeWorlds && (await exists(path.join(inst, 'saves')))) parts.push('saves');
  for (const d of parts) total += await dirSize(path.join(inst, d));
  if (total > MAX_ZIP_BYTES) throw new Error('Сборка слишком большая для экспорта (больше 1,5 ГБ). Попробуйте без миров.');

  const zip = new AdmZip();
  const json = await fsp.readFile(P.versionJson(id), 'utf8');
  zip.addFile(`version/${id}.json`, Buffer.from(json, 'utf8'));
  for (const d of parts) zip.addLocalFolder(path.join(inst, d), `instance/${d}`);
  for (const f of EXPORT_FILES) {
    if (f === 'servers.dat' && !includeWorlds) continue; // список серверов — личное, отдаём только вместе с мирами
    if (await exists(path.join(inst, f))) zip.addLocalFile(path.join(inst, f), 'instance');
  }
  const meta = { format: 1, id, name: name || id, loader: loader || null, mc: mc || null, config: config || null, worlds: !!includeWorlds, exportedAt: new Date().toISOString() };
  zip.addFile('profile.json', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
  await new Promise((resolve, reject) => zip.writeZip(file, (err) => (err ? reject(err) : resolve())));
  return { file, size: (await fsp.stat(file)).size, parts };
}

/**
 * Импорт. Для Fabric/Quilt версия создаётся из архива (библиотеки докачаются при запуске).
 * Для Forge/NeoForge её нужно установить заранее (установщик нельзя воспроизвести из json), иначе ошибка.
 * Если такой id уже есть, импорт идёт в новую копию — существующие моды и миры не затираются.
 */
async function importProfile({ root, file }) {
  const P = gamePaths(root);
  let zip;
  try { zip = new AdmZip(file); } catch (_) { throw new Error('Не удалось открыть архив.'); }
  const metaEntry = zip.getEntry('profile.json');
  if (!metaEntry) throw new Error('Это не архив сборки EWLLauncher (нет profile.json).');
  let meta;
  try { meta = JSON.parse(metaEntry.getData().toString('utf8')); } catch (_) { throw new Error('Повреждён profile.json.'); }
  if (!meta || meta.format !== 1 || typeof meta.id !== 'string') throw new Error('Неподдерживаемый формат архива.');
  const id = assertSafeId(meta.id);
  const vEntry = zip.getEntry(`version/${id}.json`);
  if (!vEntry) throw new Error('В архиве нет описания версии.');
  const installerKind = meta.loader === 'forge' || meta.loader === 'neoforge';
  const present = await exists(P.versionJson(id));

  let targetId = id;
  if (present) {
    targetId = await uniqueId(root, id);
    await cloneVersion(root, id, targetId);
  } else if (installerKind) {
    throw new Error(`Для сборки ${meta.loader === 'forge' ? 'Forge' : 'NeoForge'} сначала установите ту же версию (${id}) на вкладке «Версии», затем повторите импорт.`);
  } else {
    let vjson;
    try { vjson = JSON.parse(vEntry.getData().toString('utf8')); } catch (_) { throw new Error('Повреждено описание версии.'); }
    vjson.id = id;
    await fsp.mkdir(P.versionDir(id), { recursive: true });
    await fsp.writeFile(P.versionJson(id), JSON.stringify(vjson, null, 2));
  }
  const inst = P.instance(targetId);
  await fsp.mkdir(inst, { recursive: true });
  const n = await extractPrefix(zip, 'instance/', inst);
  return { id: targetId, name: meta.name || id, files: n, config: meta.config || null, copied: present };
}

module.exports = {
  listWorlds, backupWorlds, listBackups, restoreBackup, removeBackup,
  duplicate, exportProfile, importProfile, dirSize, cloneVersion, uniqueId, extractPrefix, inside,
};
