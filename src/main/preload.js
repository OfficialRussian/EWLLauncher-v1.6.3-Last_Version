'use strict';
/** Безопасный мост renderer <-> main: только белый список каналов, без доступа к Node. */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_RE = /^(app|dialog|settings|accounts|versions|java|game|mp|opt|skin|market|profile):[A-Za-z:]+$/;
const EVENTS = new Set([
  'evt:progress', 'evt:log', 'evt:game', 'evt:ms-code', 'evt:ms-done',
  'evt:host-step', 'evt:server-log', 'evt:server-state',
]);

contextBridge.exposeInMainWorld('ewl', {
  async invoke(channel, ...args) {
    if (!INVOKE_RE.test(channel)) throw new Error(`Запрещённый канал: ${channel}`);
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r || !r.ok) {
      const err = new Error((r && r.error && r.error.message) || 'Неизвестная ошибка');
      err.code = r && r.error && r.error.code;
      err.steps = r && r.error && r.error.steps;
      throw err;
    }
    return r.data;
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error(`Запрещённое событие: ${channel}`);
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
