/* Страница «Аккаунты»: офлайн-ники и вход через Microsoft (Device Code). */
(function () {
  'use strict';
  const { h, api, on } = EWL;

  /** Инструкция по получению Azure Client ID (нужен для входа через Microsoft). */
  EWL.showMsHelp = function showMsHelp() {
    const idInput = h('input', { type: 'text', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', value: (EWL.state.settings && EWL.state.settings.msClientId) || '' });
    EWL.modal({
      title: 'Вход через Microsoft: нужен Client ID',
      body: [
        h('p', { class: 'hint', text: 'Microsoft разрешает вход в Minecraft только зарегистрированным приложениям. Регистрация бесплатная, делается один раз:' }),
        h('ol', { class: 'hint', style: 'padding-left:18px;line-height:1.7' },
          h('li', {}, 'Откройте ', h('a', { class: 'link', text: 'Azure → Регистрация приложений', onclick: () => EWL.openExternal('https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade') }), ' и нажмите «Новая регистрация».'),
          h('li', { text: 'Тип учётных записей: «Только личные учётные записи Майкрософт». Redirect URI не нужен.' }),
          h('li', { text: 'В разделе «Проверка подлинности» включите «Разрешить публичные клиентские потоки» (Allow public client flows) = Да.' }),
          h('li', {}, 'Скопируйте «Идентификатор приложения (клиент)» и вставьте ниже.'),
          h('li', {}, 'Запросите доступ к API Minecraft для приложения: ', h('a', { class: 'link', text: 'aka.ms/AppRegInfo', onclick: () => EWL.openExternal('https://aka.ms/AppRegInfo') }), ' (без этого Mojang вернёт ошибку 403).')),
        EWL.field('Azure Client ID', idInput),
        h('p', { class: 'hint', text: 'Офлайн-режим работает без регистрации.' }),
      ],
      actions: [
        { label: 'Закрыть', kind: 'ghost' },
        {
          label: 'Сохранить', kind: 'primary',
          onClick: async (close) => {
            try {
              const v = idInput.value.trim();
              const s = await api('settings:update', { msClientId: v });
              EWL.state.settings = s;
              if (v && !s.msClientId) { EWL.toast('Client ID выглядит неверно (должен быть GUID)', 'error'); return; }
              EWL.toast('Client ID сохранён', 'ok');
              close();
              document.dispatchEvent(new CustomEvent('ewl:settings'));
            } catch (e) { EWL.fail(e); }
          },
        },
      ],
    });
  };

  EWL.pages.accounts = {
    title: 'Аккаунты',
    icon: '👤',
    render(root) {
      const subs = [];
      const listEl = h('div', { class: 'list' });
      const nameInput = h('input', { type: 'text', placeholder: 'Ник (3–16 символов: латиница, цифры, _)', maxlength: '16', onkeydown: (e) => { if (e.key === 'Enter') addOffline(); } });

      async function reload() {
        await EWL.refresh.accounts();
        draw();
        document.dispatchEvent(new CustomEvent('ewl:data'));
      }

      function draw() {
        listEl.replaceChildren();
        if (!EWL.state.accounts.length) listEl.append(h('div', { class: 'empty', text: 'Аккаунтов пока нет. Добавьте офлайн-ник или войдите через Microsoft.' }));
        for (const a of EWL.state.accounts) {
          listEl.append(h('div', { class: 'item' },
            h('div', { class: `avatar ${a.type === 'microsoft' ? 'ms' : ''}`, text: a.name.slice(0, 1).toUpperCase() }),
            h('div', { class: 'grow' }, h('div', { class: 'title', text: a.name }), h('div', { class: 'meta', text: a.type === 'microsoft' ? 'Microsoft · лицензия' : 'Офлайн' })),
            a.selected ? h('span', { class: 'badge ok', text: 'Выбран' }) : h('button', { class: 'btn small', text: 'Выбрать', onclick: async () => { await api('accounts:select', a.id).catch(EWL.fail); reload(); } }),
            h('button', { class: 'btn small danger', text: 'Удалить', onclick: async () => {
              if (await EWL.confirm(`Удалить аккаунт ${a.name}?`, 'Удалить')) { await api('accounts:remove', a.id).catch(EWL.fail); reload(); }
            } })));
        }
      }

      async function addOffline() {
        try {
          await api('accounts:addOffline', nameInput.value);
          nameInput.value = '';
          EWL.toast('Аккаунт добавлен', 'ok');
          await reload();
          EWL.welcomeSelected();
        } catch (e) { EWL.fail(e); }
      }

      async function loginMicrosoft() {
        if (!EWL.state.settings.msClientId) { EWL.showMsHelp(); return; }
        const codeEl = h('div', { class: 'ms-code', text: '…' });
        const statusEl = h('p', { class: 'hint', text: 'Получаем код входа…' });
        let uri = 'https://www.microsoft.com/link';
        const dlg = EWL.modal({
          title: 'Вход через Microsoft',
          dismissable: false,
          body: [
            h('p', { text: 'Откройте страницу входа и введите этот код:' }), codeEl,
            h('div', { class: 'row' },
              h('button', { class: 'btn primary', text: 'Открыть страницу входа', onclick: () => EWL.openExternal(uri) }),
              h('button', { class: 'btn', text: 'Скопировать код', onclick: () => EWL.copy(codeEl.textContent) })),
            statusEl,
          ],
          actions: [{ label: 'Отмена', kind: 'ghost', onClick: () => { api('accounts:msCancel').catch(() => {}); } }],
        });
        const off = on('evt:ms-code', (c) => {
          codeEl.textContent = c.userCode;
          uri = c.verificationUri;
          statusEl.textContent = 'Ожидаем подтверждения на странице Microsoft…';
          EWL.openExternal(uri);
        });
        try {
          await api('accounts:msLogin');
          await EWL.refresh.accounts();
          dlg.close();
          EWL.welcomeSelected();
        } catch (e) {
          if (!/отмен/i.test(e.message)) {
            EWL.fail(e);
            if (e.code === 'NO_CLIENT_ID' || e.code === 'BAD_CLIENT_ID') EWL.showMsHelp();
          }
        } finally {
          off();
          dlg.close();
          reload();
        }
      }

      root.append(
        h('h1', { text: 'Аккаунты' }),
        h('p', { class: 'sub', text: 'Токены Microsoft хранятся зашифрованно (Windows DPAPI).' }),
        h('div', { class: 'grid two' },
          h('div', { class: 'card' },
            h('h2', { text: 'Офлайн-режим' }),
            h('p', { class: 'hint', text: 'Для одиночной игры и серверов с отключённой проверкой лицензии.' }),
            h('div', { class: 'row' }, h('div', { style: 'flex:1' }, nameInput), h('button', { class: 'btn primary', text: 'Добавить', onclick: addOffline }))),
          h('div', { class: 'card' },
            h('h2', { text: 'Microsoft (лицензия)' }),
            h('p', { class: 'hint', text: 'Для серверов с online-mode и скинов. Вход по коду, пароль лаунчеру не передаётся.' }),
            h('div', { class: 'row' },
              h('button', { class: 'btn primary', text: 'Войти через Microsoft', onclick: loginMicrosoft }),
              h('button', { class: 'btn ghost', text: 'Где взять Client ID?', onclick: () => EWL.showMsHelp() })))),
        h('div', { class: 'card' }, h('h2', { text: 'Ваши аккаунты' }), listEl),
      );
      draw();
      EWL.refresh.accounts().then(draw);
      return () => subs.forEach((u) => u());
    },
  };
})();
