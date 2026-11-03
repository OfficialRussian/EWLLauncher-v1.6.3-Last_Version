/* Приветствие при входе: «Добро пожаловать!» и имя игрока на ~5 секунд. Закрывается кликом или Esc. */
(function () {
  'use strict';
  const { h } = EWL;
  const SHOW_MS = 5000;
  let active = null;

  EWL.welcome = function welcome(name, type) {
    if (active) active.close(true);
    const letter = String(name || '?').slice(0, 1).toUpperCase();
    const overlay = h('div', { class: 'welcome', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'welcome-card' },
        h('div', { class: 'welcome-avatar' }, h('span', { text: letter })),
        h('div', { class: 'welcome-hello', text: 'Добро пожаловать!' }),
        h('div', { class: 'welcome-name', text: name }),
        h('div', { class: 'welcome-type', text: type === 'microsoft' ? 'Microsoft · лицензия' : 'Офлайн-режим' }),
        h('div', { class: 'welcome-timer' }, h('i', { style: `animation-duration:${SHOW_MS}ms` })),
        h('div', { class: 'welcome-skip', text: 'нажмите, чтобы закрыть' })));
    let timer = null;
    let closed = false;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close(instant) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      if (active && active.overlay === overlay) active = null;
      if (instant === true) { overlay.remove(); return; }
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 450);
    }
    overlay.addEventListener('click', () => close());
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('show')));
    timer = setTimeout(() => close(), SHOW_MS);
    active = { overlay, close };
  };

  /** Приветствие для выбранного аккаунта, если оно включено в настройках. */
  EWL.welcomeSelected = function welcomeSelected() {
    const S = EWL.state;
    if (S.settings && S.settings.welcomeAnimation === false) return;
    const acc = S.accounts.find((a) => a.id === S.selectedId) || S.accounts.find((a) => a.selected);
    if (acc) EWL.welcome(acc.name, acc.type);
  };
})();
