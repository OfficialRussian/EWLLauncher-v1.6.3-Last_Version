/*
 * Страница «Играть с другом» — прямое подключение без прокси и VPN.
 *  Хозяин: запускает сервер (или использует свой) -> «Создать подключение» -> код приглашения.
 *  Друг:   вставляет код -> «Проверить» -> «Присоединиться» (игра запускается и сама заходит на сервер).
 */
(function () {
  'use strict';
  const { h, api, on } = EWL;

  const STEP_ICON = { ok: '✓', warn: '!', fail: '✕', run: '…', skip: '–' };
  const STATE_TEXT = { stopped: 'Остановлен', starting: 'Запускается…', running: 'Работает', stopping: 'Останавливается…' };

  const fmtAddr = (c) => (c.host.includes(':') ? `[${c.host}]:${c.port}` : `${c.host}:${c.port}`);
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  function check(labelNode, checked) {
    const input = h('input', { type: 'checkbox', checked });
    return { input, el: h('label', { class: 'check' }, input, h('span', {}, labelNode)) };
  }

  function stepsView(steps) {
    return h('div', { class: 'steps' }, steps.map((s) => h('div', { class: `step ${s.status}` },
      h('div', { class: 'dot', text: STEP_ICON[s.status] || '•' }),
      h('div', {}, h('div', { class: 'st', text: s.label }), s.detail ? h('div', { class: 'sd', text: s.detail }) : null))));
  }

  // =============================== ХОЗЯИН ===============================
  function hostView() {
    const S = EWL.state;
    const st = S.settings;
    const srv = st.server;
    const subs = [];
    let source = st.host.source;
    let serverState = 'stopped';
    let liveSteps = [];

    // ---- сервер ----
    const verSel = h('select');
    const port = h('input', { type: 'number', min: '1024', max: '65535', value: srv.port });
    const ram = h('input', { type: 'number', min: '512', step: '256', value: srv.ramMax });
    const maxPl = h('input', { type: 'number', min: '1', max: '200', value: srv.maxPlayers });
    const motd = h('input', { type: 'text', maxlength: '100', value: srv.motd });
    const online = check('Только лицензионные игроки (online-mode) — безопаснее', srv.onlineMode);
    const wl = check('Белый список — заходить смогут только добавленные вами игроки (рекомендуется)', srv.whitelist);
    const eula = check(['Я принимаю ', h('a', { class: 'link', text: 'лицензионное соглашение Minecraft (EULA)', onclick: (e) => { e.preventDefault(); EWL.openExternal('https://aka.ms/MinecraftEULA'); } })], srv.eulaAccepted);
    const stateBadge = h('span', { class: 'badge', text: STATE_TEXT.stopped });
    const startBtn = h('button', { class: 'btn primary', text: 'Запустить сервер', onclick: startServer });
    const stopBtn = h('button', { class: 'btn danger', text: 'Остановить сервер', onclick: () => api('mp:server:stop').catch(EWL.fail) });
    const con = h('div', { class: 'console', style: 'height:180px' });
    const cmd = h('input', { type: 'text', placeholder: 'Команда сервера, например: list', onkeydown: (e) => { if (e.key === 'Enter') sendCmd(); } });

    // ---- уже запущенный сервер ----
    const port2 = h('input', { type: 'number', min: '1', max: '65535', value: st.host.port });
    const verSel2 = h('select');

    // ---- подключение ----
    const manual = check('Порт уже проброшен на роутере вручную (пропустить UPnP)', false);
    const ttl = h('select', {}, [[60, '1 час'], [240, '4 часа'], [720, '12 часов'], [1440, '24 часа']]
      .map(([v, l]) => h('option', { value: v, text: l, selected: v === st.host.ttlMinutes })));
    const createBtn = h('button', { class: 'btn primary', text: 'Создать подключение', onclick: createConn });
    const shareStopBtn = h('button', { class: 'btn danger hidden', text: 'Закрыть подключение', onclick: () => api('mp:host:stop').then(() => { resultBox.replaceChildren(); stepsBox.replaceChildren(); shareStopBtn.classList.add('hidden'); EWL.toast('Подключение закрыто, порт на роутере освобождён', 'ok'); }).catch(EWL.fail) });
    const stepsBox = h('div');
    const resultBox = h('div');

    // ---- белый список ----
    const wlName = h('input', { type: 'text', placeholder: 'Ник друга', maxlength: '16', onkeydown: (e) => { if (e.key === 'Enter') addFriend(); } });

    const managedBox = h('div', {},
      h('div', { class: 'grid two' },
        EWL.field('Версия сервера', verSel),
        EWL.field('Порт', port, 'Стандартный порт Minecraft — 25565.')),
      h('div', { class: 'grid two' }, EWL.field('Память сервера (МБ)', ram), EWL.field('Максимум игроков', maxPl)),
      EWL.field('Название (MOTD)', motd),
      online.el, wl.el, eula.el,
      h('div', { class: 'row' }, startBtn, stopBtn, stateBadge),
      h('div', { class: 'hint', style: 'margin:10px 0' }, 'При первом запуске Windows может спросить разрешение для Java в брандмауэре — нажмите «Разрешить».'),
      con,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { style: 'flex:1' }, cmd), h('button', { class: 'btn', text: 'Отправить', onclick: sendCmd })));

    const existingBox = h('div', {},
      h('p', { class: 'hint', text: 'Запустите свой сервер или откройте одиночный мир для сети (Esc → «Открыть для сети») и укажите порт, который покажет игра.' }),
      h('div', { class: 'grid two' }, EWL.field('Порт сервера', port2), EWL.field('Версия Minecraft (для друга)', verSel2, 'У друга запустится именно эта версия.')));

    function applySource() {
      managedBox.classList.toggle('hidden', source !== 'managed');
      existingBox.classList.toggle('hidden', source !== 'existing');
    }
    const radio = (value, label) => {
      const input = h('input', { type: 'radio', name: 'srcmode', checked: source === value, onchange: () => { source = value; applySource(); api('settings:update', { host: { source } }).catch(() => {}); } });
      return h('label', { class: 'check' }, input, h('span', { text: label }));
    };

    function setServerState(info) {
      serverState = info.state;
      stateBadge.textContent = STATE_TEXT[serverState] || serverState;
      stateBadge.className = `badge ${serverState === 'running' ? 'ok' : serverState === 'stopped' ? '' : 'warn'}`;
      startBtn.disabled = serverState !== 'stopped';
      stopBtn.disabled = serverState === 'stopped' || serverState === 'stopping';
    }

    function addLog(line) {
      const atBottom = con.scrollTop + con.clientHeight >= con.scrollHeight - 30;
      con.append(h('div', { class: /ERROR|Exception/.test(line) ? 'l-error' : /WARN/.test(line) ? 'l-warn' : '', text: line }));
      while (con.childElementCount > 400) con.firstChild.remove();
      if (atBottom) con.scrollTop = con.scrollHeight;
    }

    function serverCfg() {
      return {
        versionId: verSel.value, port: Number(port.value), ramMax: Number(ram.value),
        onlineMode: online.input.checked, whitelist: wl.input.checked, maxPlayers: Number(maxPl.value),
        motd: motd.value, eulaAccepted: eula.input.checked,
      };
    }

    async function startServer() {
      if (!eula.input.checked) { EWL.toast('Примите лицензионное соглашение Minecraft (EULA)', 'warn'); return; }
      if (!verSel.value) { EWL.toast('Выберите версию сервера', 'warn'); return; }
      try { await api('mp:server:start', serverCfg()); } catch (e) { EWL.fail(e); }
    }

    function sendCmd() {
      const v = cmd.value.trim();
      if (!v) return;
      cmd.value = '';
      api('mp:server:command', v).catch(EWL.fail);
    }

    async function addFriend() {
      try {
        await api('mp:server:whitelistAdd', wlName.value);
        EWL.toast(`${wlName.value.trim()} добавлен в белый список`, 'ok');
        wlName.value = '';
      } catch (e) { EWL.fail(e); }
    }

    function renderSteps(steps) {
      liveSteps = steps.slice();
      stepsBox.replaceChildren(stepsView(liveSteps));
    }

    function showResult(res) {
      shareStopBtn.classList.remove('hidden');
      const warns = (res.warnings || []).filter(Boolean);
      resultBox.replaceChildren(
        h('div', { class: 'card', style: 'margin-top:12px;border-color:#1f5b3b' },
          h('h2', { text: 'Код приглашения для друга' }),
          h('div', { class: 'code-box', text: res.code }),
          h('div', { class: 'row', style: 'margin-top:10px' },
            h('button', { class: 'btn primary', text: 'Скопировать код', onclick: () => EWL.copy(res.code) }),
            h('span', { class: 'hint', text: `Действует до ${fmtTime(res.expiresAt)}` })),
          h('p', { class: 'hint', text: `Адреса: ${res.candidates.map(fmtAddr).join('  ·  ')}` }),
          h('p', { class: 'hint', text: 'Друг вставляет код в «Играть с другом → Я присоединяюсь». Код содержит ваш IP — отправляйте только тем, кому доверяете. Не закрывайте лаунчер, пока играете.' }),
          warns.length ? h('p', { class: 'hint', style: 'color:var(--warn)', text: 'Обратите внимание: см. отметки «!» выше.' }) : null));
    }

    async function createConn() {
      liveSteps = [];
      stepsBox.replaceChildren();
      resultBox.replaceChildren();
      createBtn.disabled = true;
      try {
        if (source === 'managed') await api('settings:update', { server: serverCfg() });
        const res = await api('mp:host:start', {
          source, port: Number(port2.value) || 25565, versionId: verSel2.value,
          ttlMinutes: Number(ttl.value), manualForward: manual.input.checked,
        });
        renderSteps(res.steps);
        showResult(res);
      } catch (e) {
        if (e.steps) renderSteps(e.steps);
        EWL.fail(e);
      } finally { createBtn.disabled = false; }
    }

    async function diagnose() {
      const dlg = EWL.modal({ title: 'Проверка сети', body: h('p', { class: 'hint', text: 'Анализируем подключение (до 5 секунд)…' }), actions: [{ label: 'Закрыть', kind: 'ghost' }] });
      try {
        const d = await api('mp:net:diagnose');
        const line = (ok, text) => h('div', { class: 'step ' + (ok === null ? 'skip' : ok ? 'ok' : 'warn') }, h('div', { class: 'dot', text: ok === null ? '–' : ok ? '✓' : '!' }), h('div', { class: 'sd', text }));
        dlg.body.replaceChildren(h('div', { class: 'steps' },
          line(!!d.publicIp, d.publicIp ? `Внешний IPv4: ${d.publicIp}` : 'Внешний IPv4 определить не удалось'),
          line(d.upnp, d.upnp ? `UPnP на роутере включён${d.routerIp ? ` (адрес роутера в интернете: ${d.routerIp})` : ''}` : 'UPnP не найден — потребуется ручной проброс порта'),
          line(!d.cgnat, d.cgnat ? 'Провайдер использует «серый» IP (CGNAT): прямое подключение по IPv4 невозможно' : 'Белый IPv4 — прямое подключение возможно'),
          line(d.ipv6 ? true : null, d.ipv6 ? `Есть глобальный IPv6: ${d.ipv6}` : 'Глобального IPv6 нет')));
      } catch (e) { dlg.close(); EWL.fail(e); }
    }

    async function fillVersions() {
      const m = await EWL.manifest();
      const releases = m ? m.versions.filter((v) => v.type === 'release').slice(0, 40).map((v) => v.id) : [];
      const fallback = S.installed.filter((v) => !v.inheritsFrom).map((v) => v.id);
      const ids = releases.length ? releases : fallback;
      verSel.replaceChildren(...ids.map((id) => h('option', { value: id, text: id })));
      const want = srv.versionId || (m && m.latest && m.latest.release);
      if (want && ids.includes(want)) verSel.value = want;
      verSel2.replaceChildren(h('option', { value: '', text: 'Не указывать' }), ...S.installed.map((v) => h('option', { value: v.id, text: EWL.versionLabel(v), selected: v.id === st.host.versionId })));
    }

    const el = h('div', {},
      h('div', { class: 'card' },
        h('h2', { text: '1. Сервер' }),
        h('div', { class: 'row' }, radio('managed', 'Создать сервер в лаунчере'), radio('existing', 'У меня уже есть сервер / открытый мир')),
        managedBox, existingBox),
      h('div', { class: 'card' },
        h('h2', { text: '2. Подключение для друга' }),
        h('p', { class: 'hint', text: 'Прямое соединение «игрок — игрок»: без прокси и VPN. Лаунчер сам откроет порт на роутере (UPnP), найдёт ваш внешний адрес и создаст код приглашения.' }),
        manual.el,
        h('div', { class: 'row' }, EWL.field('Срок действия', ttl), h('div', { class: 'spacer' }),
          h('button', { class: 'btn ghost', text: 'Проверить сеть', onclick: diagnose }), createBtn, shareStopBtn),
        stepsBox, resultBox),
      h('div', { class: 'card' },
        h('h2', { text: '3. Друзья' }),
        h('p', { class: 'hint', text: 'Если включён белый список, добавьте ник друга (он видит свой ник на вкладке «Я присоединяюсь»). Работает, когда сервер запущен из лаунчера.' }),
        h('div', { class: 'row' }, h('div', { style: 'flex:1' }, wlName), h('button', { class: 'btn', text: 'Добавить в белый список', onclick: addFriend }))));

    applySource();
    setServerState({ state: 'stopped' });
    fillVersions();
    api('mp:server:info').then((i) => { setServerState(i); (i.logs || []).forEach(addLog); }).catch(() => {});
    api('mp:host:status').then((a) => { if (a) showResult({ ...a, steps: [], warnings: [] }); }).catch(() => {});

    subs.push(on('evt:server-log', addLog));
    subs.push(on('evt:server-state', (i) => { setServerState(i); if (i.state !== 'starting') EWL.hideProgress(); }));
    subs.push(on('evt:host-step', (s) => {
      if (s.id === '_stopped') return;
      const i = liveSteps.findIndex((x) => x.id === s.id);
      if (i >= 0) liveSteps[i] = s; else liveSteps.push(s);
      stepsBox.replaceChildren(stepsView(liveSteps));
    }));
    return { el, cleanup: () => subs.forEach((u) => u()) };
  }

  // =============================== ДРУГ ===============================
  function joinView() {
    const S = EWL.state;
    const code = h('textarea', { placeholder: 'Вставьте код приглашения (EWL1-…)' });
    const allow = check('Разрешить локальные адреса (если вы в одной сети с хозяином)', S.settings.join.allowLocal);
    allow.input.addEventListener('change', async () => {
      try { S.settings = await api('settings:update', { join: { allowLocal: allow.input.checked } }); } catch (e) { EWL.fail(e); }
    });
    const accSel = h('select', {}, S.accounts.length
      ? S.accounts.map((a) => h('option', { value: a.id, selected: a.id === S.selectedId, text: `${a.name} · ${a.type === 'microsoft' ? 'Microsoft' : 'Офлайн'}` }))
      : [h('option', { value: '', text: 'Нет аккаунтов' })]);
    const verSel = h('select', {}, h('option', { value: '', text: 'Из приглашения (автоматически)' }),
      S.installed.map((v) => h('option', { value: v.id, text: EWL.versionLabel(v) })));
    const results = h('div', { style: 'margin-top:14px' });
    const checkBtn = h('button', { class: 'btn', text: 'Проверить доступность', onclick: () => inspect() });
    const joinBtn = h('button', { class: 'btn primary', text: 'Присоединиться', onclick: join });
    let busy = false;

    const selected = S.accounts.find((a) => a.selected);

    function setBusy(v) { busy = v; checkBtn.disabled = v; joinBtn.disabled = v; }

    function renderResults(r) {
      const ok = r.results.some((x) => x.ok);
      const kids = [
        h('div', { class: 'hint', text: `Хозяин: ${r.invite.name || '—'}  ·  Версия: ${r.invite.version || 'не указана'}  ·  Действует до ${fmtTime(r.invite.expiresAt)}` }),
        ...r.results.map((x) => h('div', { class: `result ${x.ok ? 'ok' : 'bad'}` },
          h('div', { class: 'row' }, h('strong', { text: x.address }), h('div', { class: 'spacer' }),
            h('span', { class: `badge ${x.ok ? 'ok' : 'warn'}`, text: x.ok ? `Доступен · ${x.latencyMs} мс` : 'Недоступен' })),
          x.ok
            ? h('div', { class: 'hint', text: `${x.version} · игроков ${x.players.online}/${x.players.max}${x.motd ? ` · ${x.motd}` : ''}` })
            : h('div', { class: 'hint' }, h('b', { text: `${x.error.title}. ` }), x.error.hint))),
      ];
      if (!ok) {
        kids.push(h('div', { class: 'hint', style: 'margin-top:8px;line-height:1.6' },
          'Что проверить: 1) хозяин запустил сервер и не закрыл лаунчер; 2) приглашение свежее; 3) у хозяина белый IP (не CGNAT) и открыт порт — пусть нажмёт «Проверить сеть»; 4) брандмауэр Windows разрешает Java; 5) для IPv6-адреса IPv6 нужен у обоих.'));
      }
      results.replaceChildren(...kids);
    }

    async function inspect() {
      if (!code.value.trim()) { EWL.toast('Вставьте код приглашения', 'warn'); return null; }
      setBusy(true);
      results.replaceChildren(h('div', { class: 'hint', text: 'Проверяем доступность сервера…' }));
      try {
        const r = await api('mp:join:inspect', { code: code.value });
        renderResults(r);
        return r;
      } catch (e) {
        results.replaceChildren(h('div', { class: 'result bad' }, h('b', { text: 'Ошибка приглашения. ' }), e.message));
        return null;
      } finally { setBusy(false); }
    }

    async function join() {
      if (!accSel.value) { EWL.toast('Сначала добавьте аккаунт', 'warn'); EWL.go('accounts'); return; }
      if (!code.value.trim()) { EWL.toast('Вставьте код приглашения', 'warn'); return; }
      setBusy(true);
      try {
        const r = await api('mp:join:launch', { code: code.value, accountId: accSel.value, versionId: verSel.value });
        EWL.toast(`Запускаем ${r.version} и подключаемся к ${r.address}`, 'ok');
      } catch (e) {
        EWL.fail(e);
        if (e.code === 'UNREACHABLE') { setBusy(false); await inspect(); }
      } finally { setBusy(false); EWL.hideProgress(); }
    }

    const el = h('div', {},
      h('div', { class: 'card' },
        h('h2', { text: 'Присоединиться к другу' }),
        h('p', { class: 'hint', text: 'Вставьте код, который прислал друг. Лаунчер проверит сервер, скачает нужную версию и автоматически зайдёт на сервер.' }),
        EWL.field('Код приглашения', code),
        allow.el,
        h('div', { class: 'grid two' }, EWL.field('Аккаунт', accSel), EWL.field('Версия Minecraft', verSel)),
        h('div', { class: 'row' }, checkBtn, joinBtn),
        results),
      h('div', { class: 'card' },
        h('h2', { text: 'Подсказки' }),
        h('p', { class: 'hint', style: 'line-height:1.6' },
          selected ? `Ваш ник: ${selected.name} — сообщите его хозяину, чтобы он добавил вас в белый список. ` : 'Добавьте аккаунт — ник понадобится хозяину для белого списка. ',
          'Если сервер хозяина требует лицензию (online-mode), заходите через аккаунт Microsoft.')));
    return { el, cleanup: () => {} };
  }

  // =============================== СТРАНИЦА ===============================
  EWL.pages.friend = {
    title: 'Играть с другом',
    icon: '🔗',
    render(root) {
      let tab = 'host';
      let current = null;
      const body = h('div');
      const tabsEl = h('div', { class: 'tabs' });

      function show() {
        if (current) current.cleanup();
        body.replaceChildren();
        current = tab === 'host' ? hostView() : joinView();
        body.append(current.el);
        tabsEl.replaceChildren(...[['host', 'Я хозяин'], ['join', 'Я присоединяюсь']].map(([k, label]) => h('button', {
          class: `tab ${tab === k ? 'active' : ''}`, text: label, onclick: () => { tab = k; show(); },
        })));
      }

      root.append(
        h('h1', { text: 'Играть с другом' }),
        h('p', { class: 'sub', text: 'Прямое подключение между двумя игроками из разных сетей — без прокси и VPN.' }),
        tabsEl, body);
      show();
      return () => { if (current) current.cleanup(); };
    },
  };
})();
