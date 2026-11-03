'use strict';
/**
 * Сеть: запросы с повторами, скачивание файлов с проверкой SHA-1/размера,
 * пул параллельных загрузок. Используется ВСЕМИ модулями, которым нужен интернет.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const UA = 'EWLLauncher/1.0';

class HttpError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortError() {
  return Object.assign(new Error('Операция отменена'), { name: 'AbortError', code: 'ABORT_ERR' });
}
function isAbort(e) {
  return !!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
}

async function request(url, opts = {}, cfg = {}) {
  const { retries = 2, timeoutMs = 30000 } = cfg;
  const userSignal = opts.signal;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (userSignal && userSignal.aborted) throw abortError();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    if (userSignal) userSignal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      });
      if (res.status >= 500 && attempt < retries) {
        lastErr = new HttpError(`HTTP ${res.status}`, res.status, url);
        await sleep(600 * (attempt + 1));
        continue;
      }
      return res;
    } catch (e) {
      if (userSignal && userSignal.aborted) throw abortError();
      lastErr = e;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

async function getJson(url, opts = {}, cfg = {}) {
  const res = await request(url, opts, cfg);
  if (!res.ok) throw new HttpError(`HTTP ${res.status} (${url})`, res.status, url);
  return res.json();
}

async function fileOk(p, size) {
  try {
    const st = await fsp.stat(p);
    return st.isFile() && st.size > 0 && (!size || st.size === size);
  } catch (_) {
    return false;
  }
}

async function sha1File(p) {
  const h = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(p), h);
  return h.digest('hex');
}

/** Файл существует, нужного размера и (если задан sha1) с правильной контрольной суммой НА ДИСКЕ. */
async function fileValid(p, { size, sha1 } = {}) {
  if (!(await fileOk(p, size))) return false;
  if (!sha1) return true;
  try { return (await sha1File(p)) === String(sha1).toLowerCase(); } catch (_) { return false; }
}

async function downloadOnce(url, dest, { sha1, size, signal, onBytes }) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await request(url, { signal }, { retries: 0, timeoutMs: 30000 });
  if (!res.ok) throw new HttpError(`HTTP ${res.status} при загрузке ${url}`, res.status, url);
  if (!res.body) throw new Error(`Пустой ответ сервера: ${url}`);

  const reader = res.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const hash = crypto.createHash('sha1');
  let bytes = 0;
  const fh = await fsp.open(tmp, 'w');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal && signal.aborted) throw abortError();
      if (done) break;
      // Копия данных: запись на диск не зависит от внутренних буферов сетевого слоя.
      const buf = Buffer.from(value);
      hash.update(buf);
      bytes += buf.length;
      let off = 0;
      while (off < buf.length) {
        const { bytesWritten } = await fh.write(buf, off, buf.length - off);
        off += bytesWritten;
      }
      if (onBytes) onBytes(buf.length);
    }
    await fh.close();
  } catch (e) {
    await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const bad = async (msg) => { await fsp.rm(tmp, { force: true }).catch(() => {}); throw new Error(msg); };
  if (size && bytes !== size) await bad(`Размер файла не совпал (${bytes} вместо ${size}): ${url}`);
  const want = sha1 ? String(sha1).toLowerCase() : '';
  if (want && hash.digest('hex') !== want) await bad(`Контрольная сумма не совпала при загрузке: ${url}`);
  // Главная проверка: сумма уже записанного файла, а не сетевого потока.
  if (want && (await sha1File(tmp)) !== want) {
    await bad(`Файл записался на диск с ошибкой (контрольная сумма не совпала): ${url}`);
  }
  await fsp.rename(tmp, dest);
}

/** Скачать файл в dest (3 попытки; 4xx не повторяются). onBytes(n) вызывается по мере поступления данных. */
async function downloadFile(url, dest, { sha1, size, signal, onBytes } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let counted = 0;
    try {
      await downloadOnce(url, dest, {
        sha1, size, signal,
        onBytes: (n) => { counted += n; if (onBytes) onBytes(n); },
      });
      return;
    } catch (e) {
      if (onBytes && counted) onBytes(-counted);
      if (isAbort(e) || (signal && signal.aborted)) throw abortError();
      lastErr = e;
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) throw e;
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Параллельно выполняет worker для каждого элемента. Первая ошибка останавливает остальных. */
async function runPool(items, concurrency, worker, signal) {
  let next = 0;
  let failure = null;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure) {
      if (signal && signal.aborted) { failure = abortError(); return; }
      const idx = next++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx], idx);
      } catch (e) {
        failure = failure || e;
        return;
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw failure;
}

/** Человекочитаемое описание сетевой ошибки (для интерфейса). */
function friendlyNetworkError(e) {
  if (!e) return 'Неизвестная сетевая ошибка';
  if (isAbort(e)) return 'Операция отменена';
  const code = (e.cause && e.cause.code) || e.code;
  switch (code) {
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'Не удаётся найти сервер: проверьте интернет-соединение и DNS.';
    case 'ECONNREFUSED': return 'Сервер отклонил соединение.';
    case 'ECONNRESET': return 'Соединение было разорвано.';
    case 'ETIMEDOUT': case 'UND_ERR_CONNECT_TIMEOUT': return 'Время ожидания ответа истекло.';
    case 'CERT_HAS_EXPIRED': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': return 'Ошибка сертификата: проверьте дату/время на компьютере и антивирус.';
    default: return e.message || String(e);
  }
}

module.exports = {
  HttpError, request, getJson, downloadFile, runPool, fileOk, fileValid, sha1File,
  sleep, abortError, isAbort, friendlyNetworkError,
};
