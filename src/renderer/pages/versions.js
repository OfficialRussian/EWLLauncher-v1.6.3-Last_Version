/* Страница «Версии»: установка Vanilla / Fabric / Quilt / Forge / NeoForge, переименование и удаление сборок установленных профилей. */
(function () {
  'use strict';
  const { h, api } = EWL;

  const KINDS = [['vanilla', 'Vanilla'], ['fabric', 'Fabric'], ['quilt', 'Quilt'], ['forge', 'Forge'], ['neoforge', 'NeoForge']];
  const isInstaller = (k) => k === 'forge' || k === 'neoforge'; // ставятся официальным установщиком
  const CHANNELS = [['release', 'Релизы'], ['snapshot', 'Снапшоты'], ['old', 'Старые']];
  const CHANNEL_TYPES = { release: ['release'], snapshot: ['snapshot'], old: ['old_beta', 'old_alpha'] };

  EWL.pages.versions = {
    title: 'Версии',
    icon: '⬇',
    render(root) {
      let kind = 'vanilla';
      let channel = 'release';
      let manifest = null;
      let busy = false;
      let loaderToken = 0;

      const seg = h('div', { class: 'seg' });
      const channelSel = h('select', { onchange: () => { channel = channelSel.value; fillMc(); } }, CHANNELS.map(([k, l]) => h('option', { value: k, text: l })));
      const mcSel = h('select', { onchange: () => { updateInstallState(); loadLoaders(); } });
      const loaderSel = h('select');
      const loaderField = EWL.field('Версия загрузчика', loaderSel);
      const optCheck = h('input', { type: 'checkbox', checked: true });
      const optRow = h('label', { class: 'check' }, optCheck, h('span', {}, 'Сразу установить моды производительности (Sodium, Lithium и др.) — игра станет заметно быстрее'));
      const hint = h('div', { class: 'hint' });
      const installBtn = h('button', { class: 'btn primary', text: 'Установить', onclick: install });
      const listEl = h('div', { class: 'list' });
      const note = h('div', { class: 'hint', style: 'margin-bottom:8px' });

      function drawSeg() {
        seg.replaceChildren(...KINDS.map(([k, label]) => h('button', {
          class: `seg-btn ${kind === k ? 'active' : ''}`, text: label,
          onclick: () => { kind = k; drawSeg(); applyKind(); },
        })));
      }

      function applyKind() {
        const loader = kind !== 'vanilla';
        loaderField.classList.toggle('hidden', !loader);
        optRow.classList.toggle('hidden', !loader || isInstaller(kind));
        hint.textContent = kind === 'forge'
          ? 'Forge: самый распространённый загрузчик модов (от 1.12.2). Ставится официальным установщиком Forge, первая установка занимает несколько минут. Профиль получит отдельную папку instances\\<профиль>. Моды производительности автоматически не ставятся.'
          : kind === 'neoforge'
            ? 'NeoForge: современный загрузчик модов (от 1.20.2). Ставится официальным установщиком NeoForge, первая установка занимает несколько минут. Профиль получит отдельную папку instances\\<профиль>. Моды производительности автоматически не ставятся.'
            : loader
              ? `${EWL.loaderName(kind)}: лёгкий загрузчик модов. Нужная библиотека (${kind === 'quilt' ? 'Quilted Fabric API' : 'Fabric API'}) установится автоматически. Профиль получит отдельную папку instances\\<профиль> со своими модами и настройками.`
              : 'Чистая версия Minecraft без модов.';
        installBtn.textContent = loader ? 'Установить профиль' : 'Установить версию';
        updateInstallState();
        loadLoaders();
      }

      function fillMc() {
        const keep = mcSel.value;
        mcSel.replaceChildren();
        if (!manifest) { mcSel.append(h('option', { value: '', text: 'Список недоступен (нет интернета)' })); updateInstallState(); return; }
        const types = CHANNEL_TYPES[channel];
        for (const v of manifest.versions.filter((x) => types.includes(x.type))) mcSel.append(h('option', { value: v.id, text: v.id }));
        if ([...mcSel.options].some((o) => o.value === keep)) mcSel.value = keep;
        updateInstallState();
        loadLoaders();
      }

      async function loadLoaders() {
        if (kind === 'vanilla') return;
        const token = ++loaderToken;
        loaderSel.replaceChildren(h('option', { value: '', text: 'Загрузка…' }));
        if (!mcSel.value) return;
        try {
          const list = await api('versions:loaders', { kind, mc: mcSel.value });
          if (token !== loaderToken) return;
          loaderSel.replaceChildren(...list.map((l) => h('option', { value: l.version, text: `${l.version}${l.stable ? '  (стабильный)' : ''}` })));
          const stable = list.find((l) => l.stable) || list[0];
          if (stable) loaderSel.value = stable.version;
          else loaderSel.replaceChildren(h('option', { value: '', text: `${EWL.loaderName(kind)} не поддерживает ${mcSel.value}` }));
        } catch (e) {
          if (token === loaderToken) loaderSel.replaceChildren(h('option', { value: '', text: 'Не удалось загрузить список' }));
        }
        updateInstallState();
      }

      function updateInstallState() {
        const installed = EWL.state.installed.some((v) => v.id === mcSel.value);
        installBtn.disabled = busy || !mcSel.value || (kind === 'vanilla' && installed);
        if (kind === 'vanilla' && installed) installBtn.textContent = 'Уже установлена';
      }

      async function install() {
        if (busy || !mcSel.value) return;
        busy = true; updateInstallState();
        try {
          if (kind === 'vanilla') {
            await api('versions:install', mcSel.value);
            EWL.toast(`Версия ${mcSel.value} установлена`, 'ok');
          } else {
            if (!loaderSel.value) throw new Error(`${EWL.loaderName(kind)} не поддерживает версию ${mcSel.value}`);
            const r = await api('versions:installLoader', { kind, mc: mcSel.value, loader: loaderSel.value, optimizeMods: !isInstaller(kind) && optCheck.checked });
            EWL.toast(`Профиль ${r.id} установлен`, 'ok');
            reportLibrary(r.library);
            if (r.optimization) {
              EWL.toast(`Моды производительности: ${r.optimization.installed.length}`, 'ok');
              if (r.optimization.skipped.length) EWL.toast(`Пропущено: ${r.optimization.skipped.map((x) => `${x.name} (${x.reason})`).join('; ')}`, 'warn', 9000);
            }
          }
        } catch (e) { if (!/отмен/i.test(e.message)) EWL.fail(e); } finally {
          busy = false;
          await refreshInstalled();
        }
      }

      /** Сообщение о Fabric API / QSL, установленных вместе с загрузчиком. */
      function reportLibrary(lib) {
        if (!lib) return;
        if (lib.installed && lib.installed.length) EWL.toast(`Библиотека установлена: ${lib.installed.map((m) => m.name).join(', ')}`, 'ok');
        else if (lib.error) EWL.toast(`Не удалось поставить Fabric API: ${lib.error}. Нажмите «Библиотеки» у профиля позже.`, 'warn', 9000);
        else if (lib.skipped && lib.skipped.length && !/уже/.test(lib.skipped[0].reason)) EWL.toast(`${lib.skipped[0].name}: ${lib.skipped[0].reason}`, 'warn', 8000);
      }

      async function installLibs(v) {
        if (busy) return;
        busy = true; updateInstallState(); drawInstalled();
        try { reportLibrary(await api('versions:installLibs', v.id)); } catch (e) { if (!/отмен/i.test(e.message)) EWL.fail(e); } finally {
          busy = false; updateInstallState(); drawInstalled();
        }
      }

      async function refreshInstalled() {
        await EWL.refresh.installed();
        document.dispatchEvent(new CustomEvent('ewl:data'));
        drawInstalled();
        applyKind();
      }

      /** Окно подтверждения удаления сборки; для профилей можно удалить и их папку (миры, моды, настройки). */
      function remove(v) {
        const name = EWL.displayName(v);
        const hasData = !!v.inheritsFrom;
        const dataChk = h('input', { type: 'checkbox' });
        const body = [
          h('p', { text: `Удалить сборку «${name}»?` }),
          h('p', { class: 'hint', text: hasData
            ? 'Будут удалены файлы этой версии. Скачанные библиотеки останутся и пригодятся другим версиям.'
            : 'Будут удалены файлы этой версии. Скачанные библиотеки и ваши миры останутся.' }),
        ];
        if (hasData) {
          body.push(h('label', { class: 'check' }, dataChk, h('span', { text: 'Также удалить папку профиля: миры, моды и настройки (это нельзя отменить)' })));
        }
        EWL.modal({
          title: 'Подтверждение удаления',
          body,
          dismissable: false,
          actions: [
            { label: 'Отмена', kind: 'ghost' },
            {
              label: 'Удалить', kind: 'danger',
              onClick: async (close) => {
                close();
                try {
                  await api('versions:remove', { id: v.id, withData: hasData && dataChk.checked });
                  await EWL.refresh.settings();
                  EWL.toast(`Сборка «${name}» удалена`, 'ok');
                  await refreshInstalled();
                } catch (e) { EWL.fail(e); }
              },
            },
          ],
        });
      }

      /** Переименование: меняется только отображаемое имя, папка и id версии остаются прежними. */
      function rename(v) {
        const input = h('input', { type: 'text', maxlength: '40', placeholder: v.id, value: EWL.customName(v.id) });
        const save = async (close) => {
          const names = { ...(EWL.state.settings.profileNames || {}) };
          const val = input.value.replace(/\s+/g, ' ').trim();
          if (val) names[v.id] = val; else delete names[v.id];
          try {
            EWL.state.settings = await api('settings:update', { profileNames: names });
            close();
            EWL.toast(val ? `Сборка переименована: «${val}»` : 'Имя сброшено', 'ok');
            await refreshInstalled();
          } catch (e) { EWL.fail(e); }
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = document.querySelector('.modal .btn.primary'); if (b) b.click(); } });
        EWL.modal({
          title: 'Переименовать сборку',
          body: [
            EWL.field('Название', input, `Настоящий идентификатор версии: ${v.id}. Он не меняется, чтобы не сломать запуск.`),
          ],
          actions: [
            { label: 'Отмена', kind: 'ghost' },
            { label: 'Сбросить имя', kind: 'ghost', onClick: (close) => { input.value = ''; save(close); } },
            { label: 'Сохранить', kind: 'primary', onClick: save },
          ],
        });
        setTimeout(() => input.focus(), 50);
      }

      /** Меню управления сборкой: имя, память, бэкапы, копия, экспорт, папки. */
      function manage(v) {
        const m = { close: null };
        const act = (label, hint, fn) => h('div', { class: 'item' },
          h('div', { class: 'grow' }, h('div', { class: 'title', text: label }), h('div', { class: 'meta', text: hint })),
          h('button', { class: 'btn small', text: 'Открыть', onclick: () => { if (m.close) m.close(); fn(); } }));
        const rows = [
          act('Переименовать', 'Изменить отображаемое название', () => rename(v)),
          act('Память и Java', 'Свой объём ОЗУ и JVM-аргументы для этой сборки', () => EWL.profileSettings(v)),
          act('Бэкапы миров', 'Сохранить и восстановить миры', () => EWL.profileBackups(v)),
          act('Создать копию', 'Дубликат сборки вместе с модами и мирами', () => duplicate(v)),
          act('Экспорт в файл', 'Архив .zip с модами и настройками, чтобы передать другу', () => exportPack(v)),
          act('Папка сборки', 'Открыть в проводнике', () => api('app:openPath', 'instance', v.id).catch(EWL.fail)),
        ];
        m.close = EWL.modal({ title: `Управление: «${EWL.displayName(v)}»`, body: [h('div', { class: 'list' }, rows)], actions: [{ label: 'Закрыть', kind: 'primary' }] }).close;
      }

      async function duplicate(v) {
        EWL.toast('Копирую сборку…', 'info');
        try {
          const r = await api('profile:duplicate', v.id);
          await EWL.refresh.settings();
          await refreshInstalled();
          EWL.toast(`Создана копия: ${r.id}`, 'ok');
        } catch (e) { EWL.fail(e); }
      }

      function exportPack(v) {
        const worlds = h('input', { type: 'checkbox' });
        EWL.modal({
          title: 'Экспорт сборки',
          body: [
            h('p', { text: `Сборка «${EWL.displayName(v)}» будет сохранена в один .zip-файл: описание версии, моды, конфиги, ресурспаки и настройки.` }),
            h('label', { class: 'check' }, worlds, h('span', { text: 'Добавить миры и список серверов (архив станет больше)' })),
            v.loader === 'forge' || v.loader === 'neoforge'
              ? h('p', { class: 'hint', text: 'Для Forge/NeoForge у получателя должна быть установлена такая же версия загрузчика.' }) : null,
          ],
          actions: [{ label: 'Отмена', kind: 'ghost' }, {
            label: 'Экспортировать', kind: 'primary',
            onClick: async (close) => {
              close();
              try {
                const r = await api('profile:export', { id: v.id, name: EWL.displayName(v), loader: v.loader, mc: v.mc, includeWorlds: worlds.checked });
                if (r) EWL.toast('Сборка сохранена в файл', 'ok');
              } catch (e) { EWL.fail(e); }
            },
          }],
        });
      }

      async function importPack() {
        try {
          const r = await api('profile:import');
          if (!r) return;
          await EWL.refresh.settings();
          await refreshInstalled();
          EWL.toast(`Сборка импортирована: «${r.name}»${r.copied ? ' (создана как копия, ваши файлы не тронуты)' : ''}`, 'ok');
        } catch (e) { EWL.fail(e); }
      }

      function drawInstalled() {
        listEl.replaceChildren();
        const items = EWL.state.installed;
        if (!items.length) listEl.append(h('div', { class: 'empty', text: 'Пока ничего не установлено. Выберите версию выше и нажмите «Установить».' }));
        for (const v of items) {
          const letter = (EWL.customName(v.id) || (v.loader ? EWL.loaderName(v.loader) : 'M')).charAt(0).toUpperCase();
          const moddable = v.loader === 'fabric' || v.loader === 'quilt';
          const custom = EWL.customName(v.id);
          listEl.append(h('div', { class: 'item' },
            h('div', { class: `avatar ${v.loader || ''}`, text: letter }),
            h('div', { class: 'grow' },
              h('div', { class: 'title', text: EWL.displayName(v) }),
              h('div', { class: 'meta', text: (custom ? `${v.id} · ` : '') + (v.loader ? `${EWL.loaderName(v.loader)} · Minecraft ${v.mc}` : `${v.type === 'release' ? 'Релиз' : v.type === 'snapshot' ? 'Снапшот' : 'Версия'}${v.releaseTime ? ` · ${EWL.fmtDate(v.releaseTime)}` : ''}`) })),
            h('button', { class: 'btn small ghost', text: 'Управление', disabled: busy, onclick: () => manage(v) }),
            moddable ? h('button', { class: 'btn small', text: 'Библиотеки', title: 'Установить Fabric API / Quilted Fabric API', disabled: busy, onclick: () => installLibs(v) }) : null,
            moddable ? h('button', { class: 'btn small', text: 'Оптимизация', disabled: busy, onclick: () => EWL.manageOptimization(v.id) }) : null,
            h('button', { class: 'btn small danger', text: 'Удалить', disabled: busy, onclick: () => remove(v) })));
        }
      }

      root.append(
        h('h1', { text: 'Версии и загрузчики' }),
        h('p', { class: 'sub', text: 'Скачивание официальных версий Minecraft и установка загрузчиков модов.' }),
        h('div', { class: 'card' },
          h('h2', { text: 'Новая установка' }),
          seg,
          h('div', { class: 'grid two', style: 'margin-top:16px' }, EWL.field('Тип версий', channelSel), EWL.field('Версия Minecraft', mcSel)),
          loaderField, optRow, hint,
          h('div', { class: 'row', style: 'margin-top:12px' }, installBtn)),
        h('div', { class: 'card' }, h('h2', { text: 'Установленные версии' }), note, listEl,
          h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn ghost', text: 'Импорт сборки из файла', onclick: importPack }))),
      );
      drawSeg();
      drawInstalled();
      applyKind();
      EWL.refresh.installed().then(() => { drawInstalled(); updateInstallState(); });
      EWL.manifest().then((m) => {
        manifest = m;
        if (!m) EWL.toast('Не удалось загрузить список версий — проверьте интернет', 'warn');
        else if (m.offline) note.textContent = 'Нет интернета: показан сохранённый список версий.';
        fillMc();
      });
      const onData = () => { drawInstalled(); updateInstallState(); };
      document.addEventListener('ewl:data', onData);
      return () => document.removeEventListener('ewl:data', onData);
    },
  };
})();
