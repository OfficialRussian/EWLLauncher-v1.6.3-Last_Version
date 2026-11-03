/* Страница «Играть»: выбор аккаунта и версии, запуск, консоль игры. */
(function () {
  'use strict';
  const { h, api, on } = EWL;

  EWL.pages.play = {
    title: 'Играть',
    icon: '▶',
    render(root) {
      const S = EWL.state;
      const subs = [];
      const accSel = h('select');
      const verSel = h('select');
      const con = h('div', { class: 'console' });
      const info = h('div', { class: 'hint' });
      let offering = false;
      const playBtn = h('button', { class: 'btn primary play', onclick: onPlayClick });
      const stopBtn = h('button', { class: 'btn danger', text: 'Остановить игру', onclick: () => { S.stopRequested = true; api('game:stop').catch(EWL.fail); } });

      function fillAccounts() {
        accSel.replaceChildren();
        if (!S.accounts.length) accSel.append(h('option', { value: '', text: 'Нет аккаунтов — добавьте в разделе «Аккаунты»' }));
        for (const a of S.accounts) {
          accSel.append(h('option', { value: a.id, selected: a.id === S.selectedId, text: `${a.name}  ·  ${a.type === 'microsoft' ? 'Microsoft' : 'Офлайн'}` }));
        }
      }

      async function fillVersions() {
        const keep = verSel.value || S.settings.lastVersion;
        verSel.replaceChildren();
        const ids = new Set();
        for (const v of S.installed) {
          ids.add(v.id);
          verSel.append(h('option', { value: v.id, text: EWL.versionLabel(v) }));
        }
        const m = await EWL.manifest();
        if (m && m.latest && !ids.has(m.latest.release)) {
          verSel.append(h('option', { value: m.latest.release, text: `${m.latest.release}  (последняя, будет скачана)` }));
        }
        if (!verSel.options.length) verSel.append(h('option', { value: '', text: 'Нет версий — установите в разделе «Версии»' }));
        const wanted = [...verSel.options].find((o) => o.value === keep);
        if (wanted) verSel.value = keep;
      }

      function updateButtons() {
        if (S.gameRunning) {
          playBtn.textContent = 'ИГРА ЗАПУЩЕНА';
          playBtn.disabled = true;
          stopBtn.classList.remove('hidden');
        } else if (S.launching) {
          playBtn.textContent = 'ОТМЕНА';
          playBtn.disabled = false;
          stopBtn.classList.add('hidden');
        } else {
          playBtn.textContent = 'ИГРАТЬ';
          playBtn.disabled = false;
          stopBtn.classList.add('hidden');
        }
      }

      async function onPlayClick() {
        if (S.launching) { api('game:cancel').catch(() => {}); return; }
        const versionId = verSel.value;
        const accountId = accSel.value;
        if (!accountId) { EWL.toast('Сначала добавьте аккаунт', 'warn'); EWL.go('accounts'); return; }
        if (!versionId) { EWL.toast('Сначала установите версию Minecraft', 'warn'); EWL.go('versions'); return; }
        if (offering) return;
        offering = true;
        let finalVersion = versionId;
        try {
          const offer = await EWL.offerOptimization(versionId);
          if (offer.action === 'switch') {
            await fillVersions();
            finalVersion = offer.id;
            verSel.value = finalVersion;
          }
        } finally { offering = false; EWL.hideProgress(); }
        S.launching = true;
        updateButtons();
        try {
          await api('accounts:select', accountId);
          await api('game:launch', { versionId: finalVersion, accountId });
          await EWL.refresh.installed();
        } catch (e) {
          if (!/отмен/i.test(e.message)) EWL.fail(e);
        } finally {
          S.launching = false;
          EWL.hideProgress();
          updateButtons();
        }
      }

      // Строки лога приходят сотнями при старте игры: складываем в очередь и выводим пачкой раз в кадр.
      let queue = [];
      let frame = 0;
      function flushLines() {
        frame = 0;
        const atBottom = con.scrollTop + con.clientHeight >= con.scrollHeight - 30;
        const frag = document.createDocumentFragment();
        for (const line of queue) {
          const cls = /\[ERROR\]/.test(line) ? 'l-error' : /\[WARN\]/.test(line) ? 'l-warn' : /\[GAME\]/.test(line) ? 'l-game' : '';
          frag.append(h('div', { class: cls, text: line }));
        }
        queue = [];
        con.append(frag);
        let extra = con.childElementCount - 600;
        while (extra-- > 0) con.firstChild.remove();
        if (atBottom) con.scrollTop = con.scrollHeight;
      }
      function addLine(line) {
        queue.push(line);
        if (queue.length > 600) queue.splice(0, queue.length - 600);
        if (!frame) frame = requestAnimationFrame(flushLines);
      }

      const s = S.settings;
      info.textContent = `Память: ${s.ramMax} МБ  ·  Папка игры: ${s.gameDir}`;

      root.append(
        h('h1', { text: 'Играть' }),
        h('p', { class: 'sub', text: 'Выберите аккаунт и версию — всё необходимое скачается автоматически.' }),
        h('p', { class: 'hint', style: 'margin:-12px 0 16px', text: 'Играйте с друзьями напрямую — без прокси и VPN.' }),
        h('div', { class: 'card hero-main' },
          h('h1', { text: 'Готов к игре' }),
          h('div', { class: 'selects' }, EWL.field('Аккаунт', accSel), EWL.field('Версия', verSel)),
          h('div', { class: 'row', style: 'justify-content:center' }, playBtn, stopBtn),
          h('div', { style: 'margin-top:14px' }, info)),
        h('div', { class: 'card' },
          h('div', { class: 'row' },
            h('h2', { text: 'Консоль', style: 'margin:0' }), h('div', { class: 'spacer' }),
            h('button', { class: 'btn small', text: 'Папка игры', onclick: () => api('app:openPath', 'game').catch(EWL.fail) }),
            h('button', { class: 'btn small', text: 'Папка логов', onclick: () => api('app:openPath', 'logs').catch(EWL.fail) }),
            h('button', { class: 'btn small ghost', text: 'Очистить', onclick: () => con.replaceChildren() })),
          h('div', { style: 'margin-top:12px' }, con)),
      );

      fillAccounts();
      fillVersions();
      updateButtons();
      api('game:status').then((st) => { S.gameRunning = st.running; S.launching = st.launching; updateButtons(); }).catch(() => {});
      api('app:logs').then((lines) => { lines.forEach(addLine); requestAnimationFrame(() => { con.scrollTop = con.scrollHeight; }); }).catch(() => {});

      subs.push(on('evt:log', addLine));
      const onGame = () => updateButtons();
      document.addEventListener('ewl:game', onGame);
      subs.push(() => document.removeEventListener('ewl:game', onGame));
      const onData = () => { fillAccounts(); fillVersions(); };
      document.addEventListener('ewl:data', onData);
      subs.push(() => document.removeEventListener('ewl:data', onData));

      return () => { if (frame) cancelAnimationFrame(frame); subs.forEach((u) => u()); };
    },
  };
})();
