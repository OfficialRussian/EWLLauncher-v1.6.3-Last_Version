/* Страница «Серверы»: избранные серверы с онлайном и пингом, запуск игры сразу на выбранный сервер. */
(function () {
  'use strict';
  const { h, api } = EWL;

  EWL.pages.servers = {
    title: 'Серверы',
    icon: '🌐',
    render(root) {
      const S = EWL.state;
      let list = [];
      let alive = true;
      const listEl = h('div', { class: 'list' });
      const name = h('input', { type: 'text', placeholder: 'Название', maxlength: '40' });
      const addr = h('input', { type: 'text', placeholder: 'Адрес: play.example.com или play.example.com:25566', maxlength: '260' });
      const verSel = h('select');
      const accSel = h('select');

      function fill() {
        verSel.replaceChildren(...S.installed.map((v) => h('option', { value: v.id, text: EWL.versionLabel(v) })));
        if (!S.installed.length) verSel.append(h('option', { value: '', text: 'Нет версий — установите в «Версиях»' }));
        const want = S.settings.lastVersion;
        if ([...verSel.options].some((o) => o.value === want)) verSel.value = want;
        accSel.replaceChildren(...S.accounts.map((a) => h('option', { value: a.id, text: `${a.name} · ${a.type === 'microsoft' ? 'Microsoft' : 'Офлайн'}` })));
        if (S.selectedId) accSel.value = S.selectedId;
      }

      function parseAddr(text) {
        const m = /^\s*([A-Za-z0-9._-]+)(?::(\d{1,5}))?\s*$/.exec(text);
        if (!m) return null;
        const port = m[2] ? Number(m[2]) : 25565;
        return port >= 1 && port <= 65535 ? { host: m[1], port } : null;
      }

      async function save() {
        list = await api('mp:serverSave', list);
      }

      async function pingOne(s, cell) {
        cell.replaceChildren(h('span', { class: 'hint', text: 'проверяю…' }));
        let r;
        try { r = await api('mp:serverPing', { host: s.host, port: s.port }); } catch (_) { r = { online: false, error: 'Ошибка' }; }
        if (!alive) return;
        if (!r.online) { cell.replaceChildren(h('span', { class: 'badge', text: r.error || 'Оффлайн' })); return; }
        cell.replaceChildren(
          h('span', { class: 'badge ok', text: `${r.players.online}/${r.players.max}` }),
          h('span', { class: 'hint', text: ` ${r.latency} мс${r.version ? ` · ${r.version}` : ''}` }));
        if (r.motd) cell.parentElement.querySelector('.meta').textContent = `${s.host}:${s.port} · ${r.motd}`;
      }

      async function play(s) {
        if (!verSel.value) { EWL.toast('Сначала установите версию Minecraft', 'warn'); return; }
        if (!accSel.value) { EWL.toast('Добавьте аккаунт в разделе «Аккаунты»', 'warn'); return; }
        try {
          EWL.toast(`Запускаю игру и захожу на ${s.name}…`, 'info');
          await api('mp:serverPlay', { host: s.host, port: s.port, versionId: verSel.value, accountId: accSel.value });
        } catch (e) { EWL.fail(e); }
      }

      function draw() {
        listEl.replaceChildren();
        if (!list.length) listEl.append(h('div', { class: 'empty', text: 'Серверов пока нет. Добавьте адрес выше.' }));
        for (const s of list) {
          const cell = h('div', { class: 'row', style: 'gap:6px;min-width:150px;justify-content:flex-end' });
          const item = h('div', { class: 'item' },
            h('div', { class: 'grow' }, h('div', { class: 'title', text: s.name }), h('div', { class: 'meta', text: `${s.host}:${s.port}` })),
            cell,
            h('button', { class: 'btn small primary', text: 'Играть', onclick: () => play(s) }),
            h('button', { class: 'btn small danger', text: 'Убрать', onclick: async () => {
              list = list.filter((x) => x !== s);
              try { await save(); } catch (e) { EWL.fail(e); }
              draw();
            } }));
          listEl.append(item);
          pingOne(s, cell);
        }
      }

      async function add() {
        const a = parseAddr(addr.value);
        if (!a) { EWL.toast('Введите адрес вида example.com или example.com:25565', 'warn'); return; }
        list = [...list, { name: name.value.trim() || a.host, host: a.host, port: a.port }];
        try { await save(); name.value = ''; addr.value = ''; } catch (e) { EWL.fail(e); }
        draw();
      }
      addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

      root.append(
        h('h1', { text: 'Серверы' }),
        h('p', { class: 'sub', text: 'Ваши любимые серверы: онлайн, пинг и вход в один клик. Игра запустится сразу с подключением.' }),
        h('div', { class: 'card' },
          h('div', { class: 'grid two' }, EWL.field('Версия для входа', verSel), EWL.field('Аккаунт', accSel)),
          h('p', { class: 'hint', text: 'Версия должна подходить серверу (смотрите пометку рядом с онлайном).' })),
        h('div', { class: 'card' },
          h('h2', { text: 'Добавить сервер' }),
          h('div', { class: 'row' }, h('div', { style: 'flex:1' }, name), h('div', { style: 'flex:2' }, addr), h('button', { class: 'btn primary', text: 'Добавить', onclick: add }))),
        h('div', { class: 'card' },
          h('div', { class: 'row' }, h('h2', { text: 'Мои серверы', style: 'margin:0' }), h('div', { class: 'spacer' }), h('button', { class: 'btn small', text: 'Обновить онлайн', onclick: draw })),
          listEl));

      fill();
      api('mp:serverList').then((l) => { list = l || []; draw(); }).catch(EWL.fail);
      return () => { alive = false; };
    },
  };
})();
