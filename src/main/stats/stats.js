'use strict';
/** Статистика игры: сколько времени и запусков на каждую версию/сборку. Файл stats.json в папке данных лаунчера. */
const path = require('path');
const { JsonStore } = require('../core/store');
const { userDataDir } = require('../core/paths');

const MIN_MS = 5000; // мгновенные падения при старте в игровое время не считаем

class Stats {
  constructor(file) {
    this.store = new JsonStore(file || path.join(userDataDir(), 'stats.json'), { playMs: {}, launches: {}, last: {} });
    this.store.load();
  }

  record(versionId, ms, at = Date.now()) {
    const id = String(versionId || '').slice(0, 100);
    if (!id) return;
    const d = this.store.data;
    d.launches[id] = (d.launches[id] || 0) + 1;
    if (Number.isFinite(ms) && ms >= MIN_MS) d.playMs[id] = (d.playMs[id] || 0) + Math.round(ms);
    d.last[id] = at;
    this.store.save();
  }

  /** Возвращает список по сборкам (больше времени — выше) и итог. */
  get() {
    const d = this.store.data;
    const ids = new Set([...Object.keys(d.playMs), ...Object.keys(d.launches)]);
    const rows = [...ids].map((id) => ({ id, playMs: d.playMs[id] || 0, launches: d.launches[id] || 0, last: d.last[id] || 0 }))
      .sort((a, b) => b.playMs - a.playMs);
    return { rows, totalMs: rows.reduce((s, r) => s + r.playMs, 0), totalLaunches: rows.reduce((s, r) => s + r.launches, 0) };
  }

  forget(versionId) {
    const d = this.store.data;
    for (const k of ['playMs', 'launches', 'last']) delete d[k][versionId];
    this.store.save();
  }
}

module.exports = { Stats, MIN_MS };
