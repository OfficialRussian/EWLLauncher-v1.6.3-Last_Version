/* Страница «Маркет модов»: поиск модов под версию и загрузчик выбранной сборки и установка в её папку mods. */
(function () {
  'use strict';
  const { h, api } = EWL;

  const SORTS = [['relevance', 'По релевантности'], ['downloads', 'По скачиваниям'], ['updated', 'Недавно обновлённые'], ['newest', 'Новые']];
  const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.0', '')} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс.` : String(n));
  const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);

  EWL.pages.market = {
    title: 'Маркет модов',
    icon: '🛒',
    render(root) {
      const profiles = () => EWL.state.installed.filter((v) => v.loader);
      let versionId = '';
      let tab = 'search';
      let source = 'modrinth';
      let sources = [{ id: 'modrinth', label: 'Modrinth', available: true, note: '' }];
      let hits = [];
      let total = 0;
      let busy = false;
      let token = 0;
      let installedFiles = [];

      const profSel = h('select', { onchange: () => { versionId = profSel.value; remember(); refreshInstalled().then(() => runSearch(true)); drawInfo(); } });
      const srcSel = h('select', { onchange: () => { source = srcSel.value; drawInfo(); runSearch(true); } });
      const sortSel = h('select', { onchange: () => runSearch(true) }, SORTS.map(([k, l]) => h('option', { value: k, text: l })));
      const query = h('input', { type: 'text', placeholder: 'Название мода: sodium, jei, journeymap…', maxlength: '80', onkeydown: (e) => { if (e.key === 'Enter') runSearch(true); } });
      const info = h('div', { class: 'hint' });
      const resultsEl = h('div', { class: 'mod-list' });
      const moreBtn = h('button', { class: 'btn', text: 'Показать ещё', onclick: () => runSearch(false) });
      const statusEl = h('div', { class: 'hint' });
      const body = h('div', { style: 'margin-top:16px' });
      const seg = h('div', { class: 'seg' });

      const cur = () => profiles().find((v) => v.id === versionId);
      const remember = () => { try { localStorage.setItem('ewl.market.profile', versionId); } catch (_) { /* хранилище недоступно */ } };

      function drawSeg() {
        seg.replaceChildren(...[['search', 'Поиск модов'], ['installed', 'Установлено в сборке'], ['content', 'Ресурспаки и шейдеры'], ['packs', 'Модпаки']].map(([k, l]) => h('button', {
          class: `seg-btn ${tab === k ? 'active' : ''}`, text: l, onclick: () => { tab = k; drawSeg(); drawBody(); if (k === 'installed') refreshInstalled(); },
        })));
      }

      function fillProfiles() {
        let saved = '';
        try { saved = localStorage.getItem('ewl.market.profile') || ''; } catch (_) { /* нет хранилища */ }
        const list = profiles();
        profSel.replaceChildren(...list.map((v) => h('option', { value: v.id, text: EWL.versionLabel(v) })));
        const want = [versionId, saved, EWL.state.settings.lastVersion].find((id) => id && list.some((v) => v.id === id));
        versionId = want || (list[0] && list[0].id) || '';
        profSel.value = versionId;
      }

      function fillSources() {
        srcSel.replaceChildren(...sources.map((s) => h('option', { value: s.id, text: s.available ? s.label : `${s.label} (скоро)`, disabled: !s.available })));
        srcSel.value = source;
      }

      function drawInfo() {
        const v = cur();
        const s = sources.find((x) => x.id === source);
        info.textContent = v
          ? `Моды подбираются под Minecraft ${v.mc} и загрузчик ${EWL.loaderName(v.loader)} и ставятся в папку mods этой сборки (instances\\${v.id}\\mods). Обязательные зависимости добавляются автоматически.${s && s.note ? ` Источник: ${s.note}` : ''}`
          : '';
      }

      const isInstalled = (hit) => installedFiles.some((f) => f.projectId && (f.projectId === hit.id || f.projectId === hit.slug));

      function drawResults() {
        resultsEl.replaceChildren();
        if (!hits.length) {
          resultsEl.append(h('div', { class: 'empty', text: busy ? 'Ищем…' : 'Ничего не найдено. Попробуйте другое название — моды ищутся только под версию и загрузчик выбранной сборки.' }));
        }
        for (const m of hits) {
          const done = isInstalled(m);
          resultsEl.append(h('div', { class: 'mod-card' },
            m.icon ? h('img', { class: 'mod-icon', src: m.icon, alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: 'mod-icon ph', text: m.title.slice(0, 1).toUpperCase() }),
            h('div', { class: 'grow' },
              h('div', { class: 'title', text: m.title }),
              h('div', { class: 'meta', text: `${m.author} · ⬇ ${fmtNum(m.downloads)}${m.updated ? ` · обновлён ${EWL.fmtDate(m.updated)}` : ''}` }),
              h('div', { class: 'mod-desc', text: m.description }),
              h('div', { class: 'row', style: 'margin-top:6px;gap:6px' }, m.categories.map((c) => h('span', { class: 'badge', text: c })))),
            done ? h('span', { class: 'badge ok', text: 'Установлен' })
              : h('button', { class: 'btn small primary', text: 'Установить', disabled: busy, onclick: () => installMod(m) })));
        }
        moreBtn.classList.toggle('hidden', hits.length >= total || !hits.length);
        statusEl.textContent = hits.length ? `Показано ${hits.length} из ${total}` : '';
      }

      async function runSearch(fresh) {
        const v = cur();
        if (!v || tab !== 'search') return;
        const mine = ++token;
        if (fresh) { hits = []; total = 0; }
        busy = true; drawResults();
        try {
          const r = await api('market:search', { source, query: query.value.trim(), mc: v.mc, kind: v.loader, sort: sortSel.value, offset: fresh ? 0 : hits.length });
          if (mine !== token) return;
          hits = fresh ? r.hits : hits.concat(r.hits);
          total = r.total;
        } catch (e) { if (mine === token) { hits = []; EWL.fail(e); } } finally { if (mine === token) { busy = false; drawResults(); } }
      }

      async function refreshInstalled() {
        if (!versionId) { installedFiles = []; return; }
        try { installedFiles = await api('market:installed', versionId); } catch (_) { installedFiles = []; }
        if (tab === 'installed') drawBody(); else drawResults();
      }

      async function installMod(m) {
        if (busy) return;
        busy = true; drawResults();
        try {
          const r = await api('market:install', { versionId, project: m.id, title: m.title, source });
          const deps = r.installed.filter((x) => x.dependency).length;
          if (r.installed.length) EWL.toast(`Установлено: ${m.title}${deps ? ` (+${deps} зависимост${deps === 1 ? 'ь' : 'и'})` : ''}`, 'ok');
          const skip = r.skipped.filter((x) => !/уже/.test(x.reason));
          if (skip.length) EWL.toast(`Пропущено: ${skip.map((x) => `${x.name} (${x.reason})`).join('; ')}`, 'warn', 8000);
          if (!r.installed.length && !skip.length) EWL.toast('Этот мод уже установлен', 'info');
        } catch (e) { if (!/отмен/i.test(e.message)) EWL.fail(e); } finally { busy = false; await refreshInstalled(); drawResults(); }
      }

      async function rollback(f) {
        if (!(await EWL.confirm(`Вернуть прошлую версию мода «${f.title || f.filename}»?`, 'Откатить'))) return;
        try { const r = await api('market:rollback', { versionId, projectId: f.projectId }); EWL.toast(`Возвращена версия ${r.version || 'прошлая'}: ${r.title}`, 'ok'); await refreshInstalled(); } catch (e) { EWL.fail(e); }
      }

      async function checkUpdates() {
        EWL.toast('Проверяю обновления…', 'info');
        let list = [];
        try { list = await api('market:checkUpdates', versionId); } catch (e) { EWL.fail(e); return; }
        if (!list.length) { EWL.toast('Все моды из маркета актуальны', 'ok'); return; }
        const checks = list.map((u) => { const c = h('input', { type: 'checkbox' }); c.checked = true; return [u, c]; });
        EWL.modal({
          title: `Доступны обновления: ${list.length}`,
          body: [
            h('p', { class: 'hint', text: 'Прошлые версии сохраняются в папке mods-backup сборки, любой мод можно откатить. Сделайте бэкап миров, если модов много.' }),
            h('div', { class: 'list' }, checks.map(([u, c]) => h('label', { class: 'item' }, c,
              h('div', { class: 'grow' }, h('div', { class: 'title', text: u.title }), h('div', { class: 'meta', text: `${u.current} → ${u.next}` }))))),
          ],
          actions: [{ label: 'Отмена', kind: 'ghost' }, {
            label: 'Обновить выбранные', kind: 'primary',
            onClick: async (close) => {
              const picked = checks.filter(([, c]) => c.checked).map(([u]) => u.projectId);
              close();
              if (!picked.length) return;
              busy = true;
              try {
                const r = await api('market:update', { versionId, projects: picked });
                EWL.toast(`Обновлено модов: ${r.updated.length}${r.failed.length ? `, не удалось: ${r.failed.map((x) => x.title).join(', ')}` : ''}`, r.failed.length ? 'warn' : 'ok', 8000);
              } catch (e) { if (!/отмен/i.test(e.message)) EWL.fail(e); } finally { busy = false; await refreshInstalled(); }
            },
          }],
        });
      }

      function drawInstalledTab() {
        const list = h('div', { class: 'list' });
        if (!installedFiles.length) list.append(h('div', { class: 'empty', text: 'В папке mods этой сборки пока нет модов.' }));
        for (const f of installedFiles) {
          list.append(h('div', { class: 'item' },
            h('div', { class: 'grow' },
              h('div', { class: 'title', text: f.title || f.filename }),
              h('div', { class: 'meta', text: `${f.title ? `${f.filename} · ` : ''}${fmtSize(f.size)}${f.version ? ` · ${f.version}` : ''}` })),
            f.tag ? h('span', { class: `badge ${f.tag === 'Маркет' ? 'ok' : ''}`, text: f.tag }) : null,
            f.hasPrevious ? h('button', { class: 'btn small ghost', text: 'Откатить', title: 'Вернуть прошлую версию мода', onclick: () => rollback(f) }) : null,
            h('button', { class: 'btn small danger', text: 'Удалить', onclick: async () => {
              if (!(await EWL.confirm(`Удалить мод ${f.title || f.filename} из сборки? Если от него зависят другие моды, они могут перестать запускаться.`, 'Удалить'))) return;
              try { await api('market:remove', { versionId, filename: f.filename }); EWL.toast('Мод удалён', 'ok'); await refreshInstalled(); } catch (e) { EWL.fail(e); }
            } })));
        }
        return [h('div', { class: 'row', style: 'margin-bottom:10px' },
          h('span', { class: 'hint', text: `Файлов: ${installedFiles.length}` }), h('div', { class: 'spacer' }),
          h('button', { class: 'btn small primary', text: 'Проверить обновления', disabled: busy, onclick: checkUpdates }),
          h('button', { class: 'btn small', text: 'Открыть папку mods', onclick: () => api('app:openPath', 'mods', versionId).catch(EWL.fail) })), list];
      }

      // ---------- модпаки ----------
      let packHits = [];
      let packTotal = 0;
      const packQuery = h('input', { type: 'text', placeholder: 'Название модпака: Fabulously Optimized, Better MC…', maxlength: '80', onkeydown: (e) => { if (e.key === 'Enter') runPacks(true); } });
      const packSort = h('select', { onchange: () => runPacks(true) }, SORTS.map(([k, l]) => h('option', { value: k, text: l })));
      const packList = h('div', { class: 'mod-list' });
      const packMore = h('button', { class: 'btn', text: 'Показать ещё', onclick: () => runPacks(false) });
      let packBusy = false;

      function drawPackList() {
        packList.replaceChildren();
        if (!packHits.length) packList.append(h('div', { class: 'empty', text: packBusy ? 'Ищем…' : 'Ничего не найдено.' }));
        for (const m of packHits) {
          packList.append(h('div', { class: 'mod-card' },
            m.icon ? h('img', { class: 'mod-icon', src: m.icon, alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: 'mod-icon ph', text: m.title.slice(0, 1).toUpperCase() }),
            h('div', { class: 'grow' },
              h('div', { class: 'title', text: m.title }),
              h('div', { class: 'meta', text: `${m.author} · ⬇ ${fmtNum(m.downloads)}${m.updated ? ` · обновлён ${EWL.fmtDate(m.updated)}` : ''}` }),
              h('div', { class: 'mod-desc', text: m.description }),
              h('div', { class: 'row', style: 'margin-top:6px;gap:6px' }, m.categories.map((c) => h('span', { class: 'badge', text: c })))),
            h('button', { class: 'btn small primary', text: 'Установить', disabled: packBusy, onclick: () => pickPackVersion(m) })));
        }
        packMore.classList.toggle('hidden', packHits.length >= packTotal || !packHits.length);
      }

      async function runPacks(fresh) {
        if (fresh) { packHits = []; packTotal = 0; }
        packBusy = true; drawPackList();
        try {
          const r = await api('market:packSearch', { query: packQuery.value.trim(), sort: packSort.value, offset: fresh ? 0 : packHits.length });
          packHits = fresh ? r.hits : packHits.concat(r.hits);
          packTotal = r.total;
        } catch (e) { packHits = []; EWL.fail(e); } finally { packBusy = false; drawPackList(); }
      }

      async function pickPackVersion(m) {
        let list = [];
        try { list = await api('market:packVersions', m.id); } catch (e) { EWL.fail(e); return; }
        if (!list.length) { EWL.toast('У этого модпака нет файлов, подходящих лаунчеру (.mrpack)', 'warn'); return; }
        const sel = h('select', {}, list.map((v) => h('option', { value: v.id, text: `${v.name} · Minecraft ${v.mc} · ${v.loaders.join('/')}${v.type !== 'release' ? ` · ${v.type}` : ''}` })));
        EWL.modal({
          title: `Установить «${m.title}»`,
          body: [
            h('p', { text: 'Будет создана новая сборка: лаунчер поставит нужную версию Minecraft и загрузчик, скачает все моды пакета и настройки.' }),
            h('p', { class: 'hint', text: 'Это может занять несколько минут и скачать сотни мегабайт. Ваши остальные сборки не затрагиваются.' }),
            EWL.field('Версия модпака', sel),
          ],
          actions: [{ label: 'Отмена', kind: 'ghost' }, {
            label: 'Установить', kind: 'primary',
            onClick: async (close) => {
              close();
              packBusy = true; drawPackList();
              try {
                const r = await api('market:packInstall', { project: m.id, version: sel.value, title: m.title });
                await EWL.refresh.settings();
                await EWL.refresh.installed();
                document.dispatchEvent(new CustomEvent('ewl:data'));
                EWL.toast(`Модпак установлен: ${r.files} файл(ов). Выберите его на вкладке «Играть»${r.skipped ? ` (пропущено недоступных: ${r.skipped})` : ''}`, 'ok', 9000);
              } catch (e) { if (!/отмен/i.test(e.message)) EWL.fail(e); } finally { packBusy = false; drawPackList(); }
            },
          }],
        });
      }

      function drawPacks() {
        body.replaceChildren(
          h('div', { class: 'card' },
            h('p', { class: 'hint', text: 'Модпаки Modrinth (.mrpack) ставятся целиком как отдельная сборка. Сборка для выбранного профиля выше здесь не нужна.' }),
            h('div', { class: 'row' }, h('div', { style: 'flex:1' }, packQuery), h('button', { class: 'btn primary', text: 'Найти', onclick: () => runPacks(true) }), packSort)),
          h('div', { class: 'card' }, packList, h('div', { class: 'row', style: 'margin-top:12px' }, packMore)));
        if (!packHits.length) runPacks(true); else drawPackList();
      }

      // ---------- ресурспаки и шейдеры ----------
      let ctype = 'resourcepack';
      let cHits = [];
      let cTotal = 0;
      let cBusy = false;
      let cInstalled = [];
      const cQuery = h('input', { type: 'text', placeholder: 'Название: Faithful, BSL, Complementary…', maxlength: '80', onkeydown: (e) => { if (e.key === 'Enter') runContent(true); } });
      const cList = h('div', { class: 'mod-list' });
      const cMore = h('button', { class: 'btn', text: 'Показать ещё', onclick: () => runContent(false) });
      const cSeg = h('div', { class: 'seg' });

      async function refreshContent() {
        try { cInstalled = await api('market:contentList', { versionId, type: ctype }); } catch (_) { cInstalled = []; }
      }

      function drawContentList() {
        cList.replaceChildren();
        if (!cHits.length) cList.append(h('div', { class: 'empty', text: cBusy ? 'Ищем…' : 'Ничего не найдено для версии этой сборки.' }));
        for (const m of cHits) {
          cList.append(h('div', { class: 'mod-card' },
            m.icon ? h('img', { class: 'mod-icon', src: m.icon, alt: '', loading: 'lazy', decoding: 'async' }) : h('div', { class: 'mod-icon ph', text: m.title.slice(0, 1).toUpperCase() }),
            h('div', { class: 'grow' },
              h('div', { class: 'title', text: m.title }),
              h('div', { class: 'meta', text: `${m.author} · ⬇ ${fmtNum(m.downloads)}` }),
              h('div', { class: 'mod-desc', text: m.description })),
            h('button', { class: 'btn small primary', text: 'Установить', disabled: cBusy, onclick: () => installContent(m) })));
        }
        cMore.classList.toggle('hidden', cHits.length >= cTotal || !cHits.length);
      }

      async function runContent(fresh) {
        const v = cur();
        if (!v) return;
        if (fresh) { cHits = []; cTotal = 0; }
        cBusy = true; drawContentList();
        try {
          const r = await api('market:contentSearch', { type: ctype, query: cQuery.value.trim(), mc: v.mc, offset: fresh ? 0 : cHits.length });
          cHits = fresh ? r.hits : cHits.concat(r.hits);
          cTotal = r.total;
        } catch (e) { cHits = []; EWL.fail(e); } finally { cBusy = false; drawContentList(); }
      }

      async function installContent(m) {
        cBusy = true; drawContentList();
        try {
          const r = await api('market:contentInstall', { versionId, project: m.id, type: ctype, title: m.title });
          EWL.toast(ctype === 'shader'
            ? `Шейдер установлен: ${m.title}. Включите его в игре: Настройки видео → Шейдеры (нужен Iris или OptiFine).`
            : `Ресурспак установлен: ${m.title}. Включите его в игре: Настройки → Ресурспаки.`, 'ok', 9000);
        } catch (e) { if (!/отмен/i.test(e.message)) EWL.fail(e); } finally { cBusy = false; await refreshContent(); drawContent(); }
      }

      function drawContent() {
        cSeg.replaceChildren(...[['resourcepack', 'Ресурспаки'], ['shader', 'Шейдеры']].map(([k, l]) => h('button', {
          class: `seg-btn ${ctype === k ? 'active' : ''}`, text: l, onclick: async () => { ctype = k; cHits = []; await refreshContent(); drawContent(); runContent(true); },
        })));
        const inst = h('div', { class: 'list', style: 'margin-top:10px' }, cInstalled.map((f) => h('div', { class: 'item' },
          h('div', { class: 'grow' }, h('div', { class: 'title', text: f.filename }), h('div', { class: 'meta', text: fmtSize(f.size) })),
          h('button', { class: 'btn small danger', text: 'Удалить', onclick: async () => {
            if (!(await EWL.confirm(`Удалить файл ${f.filename}?`, 'Удалить'))) return;
            try { await api('market:contentRemove', { versionId, type: ctype, filename: f.filename }); await refreshContent(); drawContent(); } catch (e) { EWL.fail(e); }
          } }))));
        body.replaceChildren(
          h('div', { class: 'card' },
            ctype === 'shader' ? h('p', { class: 'hint', text: 'Шейдеры работают с модом Iris (Fabric/Quilt/NeoForge) или OptiFine. Установите Iris через «Поиск модов».' }) : null,
            cSeg,
            h('div', { class: 'row', style: 'margin-top:12px' }, h('div', { style: 'flex:1' }, cQuery), h('button', { class: 'btn primary', text: 'Найти', onclick: () => runContent(true) })),
            h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small', text: 'Открыть папку', onclick: () => api('app:openPath', 'instance', versionId).catch(EWL.fail) }))),
          h('div', { class: 'card' }, cList, h('div', { class: 'row', style: 'margin-top:12px' }, cMore)),
          cInstalled.length ? h('div', { class: 'card' }, h('h2', { text: 'Уже установлено' }), inst) : null);
        drawContentList();
        if (!cHits.length && !cBusy) runContent(true);
      }

      function drawBody() {
        if (tab === 'packs') { drawPacks(); return; }
        if (!profiles().length) {
          body.replaceChildren(h('div', { class: 'card' },
            h('h2', { text: 'Нужна сборка с загрузчиком' }),
            h('p', { class: 'hint', text: 'Моды работают только с загрузчиком: Fabric, Quilt, Forge или NeoForge. Установите профиль в разделе «Версии», и здесь появится каталог модов под его версию.' }),
            h('button', { class: 'btn primary', text: 'Перейти к «Версиям»', onclick: () => EWL.go('versions') })));
          return;
        }
        if (tab === 'installed') { body.replaceChildren(h('div', { class: 'card' }, drawInstalledTab())); return; }
        if (tab === 'content') { refreshContent().then(drawContent); return; }
        if (tab === 'packs') { drawPacks(); return; }
        body.replaceChildren(
          h('div', { class: 'card' },
            h('div', { class: 'row' }, h('div', { style: 'flex:1' }, query), h('button', { class: 'btn primary', text: 'Найти', onclick: () => runSearch(true) }), sortSel)),
          h('div', { class: 'card' }, resultsEl, h('div', { class: 'row', style: 'margin-top:12px' }, moreBtn, h('div', { class: 'spacer' }), statusEl)));
        drawResults();
      }

      root.append(
        h('h1', { text: 'Маркет модов' }),
        h('p', { class: 'sub', text: 'Выберите сборку и ставьте моды в один клик: версия и загрузчик подбираются автоматически.' }),
        h('div', { class: 'card' },
          h('div', { class: 'grid two' }, EWL.field('Сборка (куда ставить)', profSel), EWL.field('Источник модов', srcSel)),
          info, h('div', { style: 'margin-top:12px' }, seg)),
        body);

      (async function init() {
        await EWL.refresh.installed();
        try { sources = await api('market:sources'); } catch (_) { /* остаётся Modrinth */ }
        fillProfiles(); fillSources(); drawInfo(); drawSeg(); drawBody();
        await refreshInstalled();
        runSearch(true);
      })();

      const onData = () => { fillProfiles(); drawInfo(); drawBody(); };
      document.addEventListener('ewl:data', onData);
      return () => { token++; document.removeEventListener('ewl:data', onData); };
    },
  };
})();
