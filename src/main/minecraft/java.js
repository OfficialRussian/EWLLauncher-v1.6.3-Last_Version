'use strict';
/**
 * Java: поиск установленных JRE/JDK, проверка версии, автоматическая загрузка
 * официального рантайма Mojang (тот же, что использует оригинальный лаунчер).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const http = require('../core/http');
const { gamePaths } = require('../core/paths');
const logger = require('../core/logger');

const RUNTIME_INDEX = 'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

/** '1.8.0_341' -> 8, '17.0.5' -> 17, '21' -> 21 */
function parseJavaMajor(output) {
  const m = /version\s+"([^"]+)"/i.exec(String(output));
  if (!m) return null;
  const parts = m[1].split(/[._-]/);
  const first = parseInt(parts[0], 10);
  if (first === 1) return parseInt(parts[1], 10) || null;
  return Number.isFinite(first) ? first : null;
}

function probeJava(javaPath) {
  return new Promise((resolve) => {
    execFile(javaPath, ['-version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stderr || ''}${stdout || ''}`;
      const major = parseJavaMajor(out);
      if (!major) return resolve(null);
      const v = /version\s+"([^"]+)"/i.exec(out);
      resolve({ path: javaPath, major, version: v ? v[1] : String(major), is64: /64-Bit/i.test(out) });
    });
  });
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch (_) { return false; }
}

async function candidatePaths() {
  const found = new Set();
  const add = async (p) => { if (p && await exists(p)) found.add(path.resolve(p)); };

  if (process.env.JAVA_HOME) await add(path.join(process.env.JAVA_HOME, 'bin', EXE));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) await add(path.join(dir.replace(/^"|"$/g, ''), EXE));
  }
  if (process.platform === 'win32') {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    const vendors = ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft',
      'Amazon Corretto', 'AdoptOpenJDK', 'Semeru', 'OpenJDK', 'Temurin'];
    for (const b of bases) {
      for (const v of vendors) {
        const dir = path.join(b, v);
        let subs = [];
        try { subs = await fsp.readdir(dir); } catch (_) { continue; }
        for (const s of subs) await add(path.join(dir, s, 'bin', EXE));
      }
    }
  }
  return [...found];
}

async function detectJavas() {
  const list = [];
  for (const p of await candidatePaths()) {
    const info = await probeJava(p);
    if (info) list.push(info);
  }
  list.sort((a, b) => b.major - a.major);
  return list;
}

function runtimePlatformKey() {
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'windows-arm64' : process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  }
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return 'linux';
}

/** Скачивает рантайм Mojang (например java-runtime-gamma) в <gameDir>/runtime/<component>. */
async function installBundledRuntime(root, component, { onProgress = () => {}, signal } = {}) {
  const P = gamePaths(root);
  const dir = path.join(P.runtime, component);
  const javaBin = path.join(dir, 'bin', EXE);
  const marker = path.join(dir, '.ewl-installed-v2');
  if (await exists(marker) && await exists(javaBin)) return javaBin;

  onProgress({ text: `Поиск Java (${component})…`, fraction: 0 });
  const all = await http.getJson(RUNTIME_INDEX, { signal }, { retries: 2 });
  const entry = all && all[runtimePlatformKey()] && all[runtimePlatformKey()][component] && all[runtimePlatformKey()][component][0];
  if (!entry) throw new Error(`Для вашей системы нет рантайма Java «${component}»`);
  const manifest = await http.getJson(entry.manifest.url, { signal }, { retries: 2 });

  const files = Object.entries(manifest.files || {}).filter(([, f]) => f.type === 'file' && f.downloads && f.downloads.raw);
  const tasks = files.map(([rel, f]) => ({ rel, f }));
  const total = tasks.reduce((s, t) => s + (t.f.downloads.raw.size || 0), 0);
  let done = 0;
  let last = 0;
  const base = path.resolve(dir) + path.sep;
  await http.runPool(tasks, 8, async ({ rel, f }) => {
    const dest = path.resolve(dir, rel);
    if (!dest.startsWith(base)) throw new Error(`Небезопасный путь в манифесте Java: ${rel}`);
    const raw = f.downloads.raw;
    if (!(await http.fileValid(dest, { size: raw.size, sha1: raw.sha1 }))) {
      await http.downloadFile(raw.url, dest, {
        sha1: raw.sha1, size: raw.size, signal,
        onBytes: (n) => {
          done += n;
          const now = Date.now();
          if (now - last > 150) {
            last = now;
            onProgress({ text: `Загрузка Java ${Math.round((done / (total || 1)) * 100)}%`, fraction: Math.min(1, done / (total || 1)) });
          }
        },
      });
    } else {
      done += raw.size || 0;
    }
    if (f.executable && process.platform !== 'win32') await fsp.chmod(dest, 0o755).catch(() => {});
  }, signal);

  await fsp.writeFile(marker, new Date().toISOString());
  if (!(await exists(javaBin))) throw new Error('После установки Java не найден bin/java');
  return javaBin;
}

/**
 * Выбор Java для запуска. Порядок:
 *  1) путь из настроек, 2) рантайм Mojang, 3) подходящая системная Java.
 */
async function ensureJava({ root, version, settings, onProgress, signal }) {
  const required = (version.javaVersion && version.javaVersion.majorVersion) || 8;
  const component = (version.javaVersion && version.javaVersion.component) || 'jre-legacy';

  if (settings.javaPath) {
    if (!(await exists(settings.javaPath))) throw new Error(`Java не найдена по пути из настроек: ${settings.javaPath}`);
    const info = await probeJava(settings.javaPath);
    if (!info) throw new Error('Указанный файл не является Java (не удалось выполнить java -version).');
    if (info.major < required) throw new Error(`Для этой версии Minecraft нужна Java ${required}+, а в настройках указана Java ${info.major}.`);
    return { path: settings.javaPath, major: info.major, source: 'settings' };
  }

  let bundledError = null;
  if (settings.useBundledJava !== false) {
    try {
      const p = await installBundledRuntime(root, component, { onProgress, signal });
      return { path: p, major: required, source: 'bundled' };
    } catch (e) {
      if (http.isAbort(e)) throw e;
      bundledError = e;
      logger.warn(`Не удалось получить рантайм Mojang: ${e.message}`);
    }
  }

  const system = (await detectJavas()).filter((j) => j.major >= required).sort((a, b) => a.major - b.major);
  if (system.length) return { path: system[0].path, major: system[0].major, source: 'system' };

  const reason = bundledError ? ` (${http.friendlyNetworkError(bundledError)})` : '';
  throw new Error(`Не найдена подходящая Java ${required}+${reason}. Подключитесь к интернету или укажите Java в настройках.`);
}

module.exports = { parseJavaMajor, probeJava, detectJavas, ensureJava, installBundledRuntime, runtimePlatformKey };
