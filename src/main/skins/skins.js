'use strict';
/**
 * Скины: библиотека PNG-файлов пользователя, проверка формата, текущий скин аккаунта Microsoft и его загрузка.
 * Редактор живёт в интерфейсе (pages/skins.js), сюда он отдаёт готовый PNG в виде data-URL.
 * Для офлайн-аккаунтов скин на сервере показать нельзя (у них нет профиля Mojang) — PNG можно только сохранить.
 */
const fsp = require('fs').promises;
const path = require('path');
const http = require('../core/http');
const { userDataDir } = require('../core/paths');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 200 * 1024;
const SERVICES = 'https://api.minecraftservices.com';
const SESSION = 'https://sessionserver.mojang.com/session/minecraft/profile';
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Проверяет PNG-скин: подпись, размер 64x64 или 64x32, объём. Возвращает { width, height }. */
function validatePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('Это не PNG-изображение.');
  }
  if (buf.length > MAX_BYTES) throw new Error('Файл скина слишком большой (допустимо до 200 КБ).');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) throw new Error(`Размер скина должен быть 64×64 (или 64×32), а не ${width}×${height}.`);
  return { width, height };
}

function parseDataUrl(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Ожидается PNG-изображение.');
  const buf = Buffer.from(m[1], 'base64');
  validatePng(buf);
  return buf;
}

const toDataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

function safeName(name) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z0-9А-Яа-яЁё _.-]{1,40}$/.test(n) || n.startsWith('.') || n.endsWith('.') || RESERVED.test(n)) {
    throw new Error('Название скина: 1–40 символов (буквы, цифры, пробел, _ - .).');
  }
  return n;
}

class SkinService {
  constructor(dir) { this._dir = dir || path.join(userDataDir(), 'skins'); }

  dir() { return this._dir; }

  _file(name) { return path.join(this._dir, `${safeName(name)}.png`); }

  async list() {
    let files = [];
    try { files = await fsp.readdir(this._dir); } catch (_) { return []; }
    const out = [];
    for (const f of files) {
      if (!/\.png$/i.test(f)) continue;
      try {
        const file = path.join(this._dir, f);
        const buf = await fsp.readFile(file);
        validatePng(buf);
        out.push({ name: f.replace(/\.png$/i, ''), dataUrl: toDataUrl(buf), modified: (await fsp.stat(file)).mtimeMs });
      } catch (_) { /* посторонний или битый файл в папке скинов — пропускаем */ }
    }
    out.sort((a, b) => b.modified - a.modified);
    return out;
  }

  async save(name, dataUrl) {
    const buf = parseDataUrl(dataUrl);
    await fsp.mkdir(this._dir, { recursive: true });
    await fsp.writeFile(this._file(name), buf);
    return safeName(name);
  }

  async remove(name) { await fsp.rm(this._file(name), { force: true }); }
}

function uploadError(status) {
  if (status === 401) return 'Сессия Microsoft устарела — войдите в аккаунт заново (раздел «Аккаунты»).';
  if (status === 403) return 'Mojang не разрешил менять скин для этого аккаунта.';
  if (status === 429) return 'Слишком много запросов к Mojang. Подождите минуту и повторите.';
  if (status === 400) return 'Mojang отклонил этот скин. Проверьте, что это PNG 64×64.';
  return `Не удалось загрузить скин (HTTP ${status}).`;
}

/** Загружает скин в профиль Microsoft/Minecraft. variant: 'classic' (руки 4 px) или 'slim' (3 px). */
async function uploadSkin(token, png, variant, signal) {
  validatePng(png);
  const form = new FormData();
  form.append('variant', variant === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([png], { type: 'image/png' }), 'skin.png');
  const res = await http.request(`${SERVICES}/minecraft/profile/skins`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal,
  }, { retries: 0, timeoutMs: 60000 });
  if (!res.ok) throw new Error(uploadError(res.status));
  return true;
}

/** Текущий скин аккаунта по UUID: { dataUrl, variant } или null, если скин стандартный/не найден. */
async function fetchCurrentSkin(uuid, signal) {
  const id = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(id)) throw new Error('Некорректный UUID аккаунта.');
  const prof = await http.getJson(`${SESSION}/${id}`, { signal }, { retries: 1 }).catch((e) => {
    if (e instanceof http.HttpError && (e.status === 204 || e.status === 404)) return null;
    throw e;
  });
  const prop = prof && Array.isArray(prof.properties) && prof.properties.find((p) => p.name === 'textures');
  if (!prop) return null;
  let tex;
  try { tex = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')); } catch (_) { return null; }
  const skin = tex && tex.textures && tex.textures.SKIN;
  if (!skin || !skin.url) return null;
  const url = new URL(skin.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!/(^|\.)minecraft\.net$/.test(url.hostname)) throw new Error('Неожиданный адрес скина.');
  const res = await http.request(url.href, { signal }, { retries: 1 });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  validatePng(buf);
  return { dataUrl: toDataUrl(buf), variant: skin.metadata && skin.metadata.model === 'slim' ? 'slim' : 'classic' };
}

module.exports = { SkinService, validatePng, parseDataUrl, toDataUrl, uploadSkin, fetchCurrentSkin, safeName };
