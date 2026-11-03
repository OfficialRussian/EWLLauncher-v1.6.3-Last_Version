/* Утилиты интерфейса: DOM-хелпер h(), toast, modal, общий кэш данных. Всё доступно через window.EWL. */
(function () {
  'use strict';
  const EWL = (window.EWL = { pages: {}, state: { settings: null, accounts: [], selectedId: '', installed: [], gameRunning: false, launching: false } });

  EWL.api = (channel, ...args) => window.ewl.invoke(channel, ...args);
  EWL.on = (channel, cb) => window.ewl.on(channel, cb);

  /** h('div', {class:'x', onclick: fn}, child, 'text') — безопасное создание DOM (без innerHTML). */
  EWL.h = function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };
  const h = EWL.h;

  EWL.toast = function toast(message, kind = 'info', ms = 4500) {
    const t = h('div', { class: `toast ${kind}`, text: message });
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), ms);
  };

  /** Показывает сообщение об ошибке и возвращает его текст. */
  EWL.fail = function fail(e) {
    const msg = (e && e.message) || String(e);
    EWL.toast(msg, 'error', 7000);
    return msg;
  };

  /** Модальное окно. actions: [{label, kind, onClick(close)}]. Возвращает { close, body }. */
  EWL.modal = function modal({ title, body, actions = [], dismissable = true }) {
    const root = document.getElementById('modal-root');
    const overlay = h('div', { class: 'overlay' });
    const close = () => overlay.remove();
    const acts = h('div', { class: 'modal-actions' },
      actions.map((a) => h('button', { class: `btn ${a.kind || ''}`, text: a.label, onclick: () => a.onClick ? a.onClick(close) : close() })));
    const bodyEl = h('div', {}, body);
    overlay.append(h('div', { class: 'modal' }, h('h2', { text: title }), bodyEl, actions.length ? acts : null));
    if (dismissable) overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    root.append(overlay);
    return { close, body: bodyEl };
  };

  EWL.confirm = function confirm(text, okLabel = 'Да') {
    return new Promise((resolve) => {
      EWL.modal({
        title: 'Подтверждение',
        body: h('p', { text }),
        actions: [
          { label: 'Отмена', kind: 'ghost', onClick: (c) => { c(); resolve(false); } },
          { label: okLabel, kind: 'danger', onClick: (c) => { c(); resolve(true); } },
        ],
        dismissable: false,
      });
    });
  };

  EWL.copy = async function copy(text) {
    try { await navigator.clipboard.writeText(text); EWL.toast('Скопировано', 'ok', 1800); } catch (_) { EWL.toast('Не удалось скопировать — выделите текст вручную', 'warn'); }
  };

  EWL.fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString('ru-RU'); } catch (_) { return ''; } };

  EWL.field = (label, control, hint) => h('div', { class: 'field' }, h('label', { text: label }), control, hint ? h('div', { class: 'hint', text: hint }) : null);

  // ----- общий кэш -----
  EWL.refresh = {
    async settings() { EWL.state.settings = await EWL.api('settings:get'); return EWL.state.settings; },
    async accounts() {
      const r = await EWL.api('accounts:list');
      EWL.state.accounts = r.accounts;
      EWL.state.selectedId = r.selectedId;
      return r;
    },
    async installed() { EWL.state.installed = await EWL.api('versions:installed'); return EWL.state.installed; },
  };

  let manifestPromise = null;
  /** Манифест версий (кэшируется на время сессии). null — если нет интернета и нет кэша. */
  EWL.manifest = function manifest(force) {
    if (!manifestPromise || force) manifestPromise = EWL.api('versions:manifest').catch(() => null);
    return manifestPromise;
  };

  EWL.openExternal = (url) => EWL.api('app:openExternal', url).catch(EWL.fail);

  EWL.loaderName = (k) => ({ fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }[k] || k || '');
  /** Имя сборки, которое дал пользователь (или пустая строка). */
  EWL.customName = (id) => ((EWL.state.settings && EWL.state.settings.profileNames) || {})[id] || '';
  /** Заголовок сборки в списках: своё имя или id. */
  EWL.displayName = (v) => EWL.customName(v.id) || v.id;
  EWL.versionLabel = (v) => {
    const custom = EWL.customName(v.id);
    if (custom) return `${custom}  (${v.id})`;
    return v.loader ? `${v.id}  (${EWL.loaderName(v.loader)})` : v.id;
  };

  EWL.applyPerf = function applyPerf(on) { document.documentElement.setAttribute('data-perf', on ? 'on' : 'off'); };

  /** Тема оформления: dark | light | midnight | amoled (атрибут data-theme на <html>). */
  EWL.applyTheme = function applyTheme(name) {
    document.documentElement.setAttribute('data-theme', ['light', 'midnight', 'amoled'].includes(name) ? name : 'dark');
  };

  /** Проверка новой версии лаунчера. quiet — не сообщать, если обновлений нет или нет сети. */
  EWL.checkUpdate = async function checkUpdate({ quiet = true } = {}) {
    try {
      const r = await EWL.api('app:checkUpdate');
      if (r && r.available) {
        EWL.modal({
          title: `Доступна версия ${r.version}`,
          body: [EWL.h('p', { text: 'Вышла новая версия EWLLauncher.' }), r.notes ? EWL.h('p', { class: 'hint', text: r.notes }) : null].filter(Boolean),
          actions: [{ label: 'Позже', kind: 'ghost' }, { label: 'Открыть страницу загрузки', kind: 'primary', onClick: (close) => { close(); EWL.api('app:openExternal', r.url).catch(EWL.fail); } }],
        });
      } else if (!quiet) {
        EWL.toast(r && r.reason === 'no-releases' ? 'В репозитории ещё нет опубликованных релизов' : 'У вас последняя версия', 'ok');
      }
    } catch (e) { if (!quiet) EWL.fail(e); }
  };

  /** Применяет акцентный цвет: считает второй оттенок градиента и цвет текста на кнопках. */
  EWL.applyAccent = function applyAccent(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    const c = m ? m[1] : '3ddc84';
    const r = parseInt(c.slice(0, 2), 16); const g = parseInt(c.slice(2, 4), 16); const b = parseInt(c.slice(4, 6), 16);
    // сдвиг оттенка на +28° для второго цвета градиента
    const mx = Math.max(r, g, b) / 255; const mn = Math.min(r, g, b) / 255; const l = (mx + mn) / 2; const d = mx - mn;
    let hh = 0;
    if (d) {
      if (mx === r / 255) hh = ((g - b) / 255 / d) % 6; else if (mx === g / 255) hh = (b - r) / 255 / d + 2; else hh = (r - g) / 255 / d + 4;
      hh *= 60; if (hh < 0) hh += 360;
    }
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    const h2 = (hh + 28) % 360;
    const k = (n) => (n + h2 / 30) % 12; const a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    const hex2 = `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const root = document.documentElement.style;
    root.setProperty('--accent', `#${c}`);
    root.setProperty('--accent2', hex2);
    root.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    root.setProperty('--accent-ink', lum > 0.55 ? '#08130c' : '#ffffff');
  };
})();
