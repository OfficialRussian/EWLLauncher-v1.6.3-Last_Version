/* Роутер, общий прогресс-бар и глобальные события. Загружается последним. */
(function () {
  'use strict';
  const { h, api, on } = EWL;
  const S = EWL.state;

  const ORDER = ['play', 'versions', 'market', 'servers', 'accounts', 'skins', 'stats', 'friend', 'settings'];
  const content = document.getElementById('content');
  const nav = document.getElementById('nav');
  let current = null;
  let cleanup = null;

  EWL.go = function go(name) {
    if (!EWL.pages[name]) return;
    if (cleanup) { try { cleanup(); } catch (_) { /* страница уже убрана */ } }
    content.replaceChildren();
    content.scrollTop = 0;
    current = name;
    cleanup = EWL.pages[name].render(content) || null;
    drawNav();
  };

  function drawNav() {
    nav.replaceChildren(...ORDER.map((k) => h('button', {
      class: `nav-btn ${current === k ? 'active' : ''}`,
      onclick: () => EWL.go(k),
    }, h('span', { class: 'nav-ico', text: EWL.pages[k].icon }), h('span', { text: EWL.pages[k].title }))));
  }

  // ----- общий прогресс -----
  const bar = document.getElementById('statusbar');
  const barText = document.getElementById('status-text');
  const barFill = document.getElementById('status-fill');
  const barCancel = document.getElementById('status-cancel');
  let progressScope = null;

  EWL.showProgress = (text, fraction) => {
    bar.classList.remove('hidden');
    barText.textContent = text;
    barFill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100)}%`;
  };
  EWL.hideProgress = () => { bar.classList.add('hidden'); progressScope = null; };

  barCancel.addEventListener('click', () => {
    const ch = progressScope === 'install' ? 'versions:cancel' : progressScope === 'server' ? 'mp:server:cancel' : 'game:cancel';
    api(ch).catch(() => {});
  });

  let lastProgress = null;
  let progressFrame = 0;
  on('evt:progress', (p) => {
    if (p.done) { lastProgress = null; EWL.hideProgress(); return; }
    progressScope = p.scope;
    lastProgress = p;
    if (!progressFrame) {
      progressFrame = requestAnimationFrame(() => {
        progressFrame = 0;
        if (lastProgress) EWL.showProgress(lastProgress.label ? `${lastProgress.label}: ${lastProgress.text}` : lastProgress.text, lastProgress.fraction);
      });
    }
  });

  // ----- события игры -----
  on('evt:game', (e) => {
    if (e.type === 'started') {
      S.gameRunning = true;
      S.launching = false;
      EWL.hideProgress();
      EWL.toast('Игра запущена. Приятной игры!', 'ok');
    } else if (e.type === 'exit') {
      S.gameRunning = false;
      S.launching = false;
      const stopped = S.stopRequested;
      S.stopRequested = false;
      if (!stopped && (e.error || (e.code !== 0 && e.code !== null))) showCrash(e);
    }
    document.dispatchEvent(new CustomEvent('ewl:game', { detail: e }));
  });

  /** Окно после вылета: найденные причины (EWL: разбор лога) + кнопки действий + сам лог. */
  function showCrash(e) {
    const tail = (e.tail || []).slice(-60).join('\n');
    const a = e.analysis || null;
    const findings = (a && a.findings) || [];
    const dlg = { close: () => {} };
    const ACTIONS = {
      settings: ['Открыть настройки', () => EWL.go('settings')],
      versions: ['Открыть «Версии»', () => EWL.go('versions')],
      libs: ['Открыть «Версии»', () => EWL.go('versions')],
      accounts: ['Открыть «Аккаунты»', () => EWL.go('accounts')],
      market: ['Открыть «Маркет модов»', () => EWL.go('market')],
      mods: ['Открыть папку модов', () => api('app:openPath', 'mods', a && a.versionId).catch(EWL.fail)],
      files: ['Файлы лаунчера', () => EWL.openFiles()],
    };
    const cards = findings.map((f) => {
      const act = f.action && ACTIONS[f.action];
      return h('div', { class: 'crash-card' },
        h('div', { class: 'crash-title', text: f.title }),
        h('p', { class: 'hint', text: f.cause }),
        h('ul', { class: 'crash-steps' }, (f.steps || []).map((st) => h('li', { text: st }))),
        f.mods && f.mods.length ? h('div', { class: 'hint', text: `В логе упоминаются: ${f.mods.join(', ')}` }) : null,
        act ? h('button', { class: 'btn small', text: act[0], onclick: () => { dlg.close(); act[1](); } }) : null);
    });
    const sum = a && a.summary;
    const body = [
      h('p', { class: 'hint', text: e.error
        || (cards.length ? 'Лаунчер разобрал лог игры и нашёл вероятные причины (самые вероятные сверху):'
          : 'Точную причину определить не удалось. Частые причины: несовместимые моды, мало памяти (увеличьте RAM в настройках), неподходящая Java.') }),
      a && a.exitInfo ? h('p', { class: 'hint', text: `Код завершения ${e.code}: ${a.exitInfo}.` }) : null,
      ...cards,
      sum && sum.suspects && sum.suspects.length ? h('p', { class: 'hint', text: `Подозреваемые моды (из crash-report): ${sum.suspects.join('; ')}` }) : null,
      sum && sum.exception ? h('p', { class: 'hint mono', text: sum.exception }) : null,
      h('details', {}, h('summary', { class: 'hint', text: 'Показать лог игры' }), h('div', { class: 'console', style: 'height:220px;margin-top:8px', text: tail || 'Вывод игры пуст.' })),
    ];
    const m = EWL.modal({
      title: e.error ? 'Не удалось запустить игру' : `Игра завершилась с ошибкой (код ${e.code})`,
      body,
      actions: [
        { label: 'Копировать лог', kind: 'ghost', onClick: () => EWL.copy(tail) },
        a && a.crashFile ? { label: 'Crash-report', kind: 'ghost', onClick: () => api('app:openPath', 'crash').catch(EWL.fail) } : null,
        { label: 'Папка логов', kind: 'ghost', onClick: () => api('app:openPath', 'logs').catch(EWL.fail) },
        { label: 'Закрыть', kind: 'primary' },
      ].filter(Boolean),
    });
    dlg.close = m.close;
  }

  document.addEventListener('ewl:settings', () => { EWL.applyAccent(S.settings && S.settings.accent); EWL.applyTheme(S.settings && S.settings.theme); EWL.applyPerf(S.settings && S.settings.performanceMode); });
  document.getElementById('files-btn').addEventListener('click', () => EWL.openFiles());

  // ----- запуск -----
  (async function boot() {
    try {
      await Promise.all([EWL.refresh.settings(), EWL.refresh.accounts(), EWL.refresh.installed()]);
      EWL.applyAccent(S.settings.accent);
      EWL.applyTheme(S.settings.theme);
      EWL.applyPerf(S.settings.performanceMode);
      const info = await api('app:info');
      document.getElementById('brand-ver').textContent = `v${info.version} · Minecraft Java`;
    } catch (e) {
      EWL.fail(e);
    }
    drawNav();
    if (!S.accounts.length) {
      EWL.go('accounts');
      EWL.toast('Добавьте офлайн-ник или войдите через Microsoft, чтобы начать.', 'info', 7000);
    } else {
      EWL.go('play');
      EWL.welcomeSelected();
    }
    // Проверка обновлений лаунчера: молча, через пару секунд после старта (после приветствия).
    if (S.settings && S.settings.checkUpdates !== false) setTimeout(() => EWL.checkUpdate({ quiet: true }), 7000);
  })();
})();
