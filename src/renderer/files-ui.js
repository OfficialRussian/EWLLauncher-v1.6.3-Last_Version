/* Окно «Файлы лаунчера»: быстрый доступ к папкам игры, профилей, данных, логов, скинов и сервера. */
(function () {
  'use strict';
  const { h, api } = EWL;

  const ITEMS = [
    ['game', 'Папка игры', 'Версии, библиотеки, ресурсы, миры и моды обычных версий', '📁'],
    ['instances', 'Профили (сборки)', 'Отдельные папки Fabric, Quilt, Forge, NeoForge: свои моды, миры, настройки', '🧩'],
    ['data', 'Данные лаунчера', 'Настройки и аккаунты (токены зашифрованы)', '⚙'],
    ['skins', 'Скины', 'Сохранённые вами PNG-скины', '🎨'],
    ['server', 'Сервер для друзей', 'Файлы и мир вашего сервера', '🖧'],
    ['logs', 'Логи', 'Для поиска причин ошибок', '📝'],
  ];

  EWL.openFiles = async function openFiles() {
    let paths = {};
    try { paths = await api('app:paths'); } catch (e) { EWL.fail(e); return; }
    const rows = ITEMS.map(([kind, title, desc, icon]) => h('div', { class: 'item files-row' },
      h('div', { class: 'files-ico', text: icon }),
      h('div', { class: 'grow' },
        h('div', { class: 'title', text: title }),
        h('div', { class: 'meta', text: desc }),
        h('div', { class: 'meta mono', text: paths[kind] || '' })),
      h('button', { class: 'btn small', text: 'Копировать путь', onclick: () => EWL.copy(paths[kind] || '') }),
      h('button', { class: 'btn small primary', text: 'Открыть', onclick: () => api('app:openPath', kind).catch(EWL.fail) })));
    EWL.modal({
      title: 'Файлы лаунчера',
      body: [h('p', { class: 'hint', text: 'Откройте нужную папку в проводнике. Менять файлы вручную стоит при закрытом лаунчере и выключенной игре.' }), h('div', { class: 'list' }, rows)],
      actions: [{ label: 'Закрыть', kind: 'primary' }],
    });
  };
})();
