/* Общие окна оптимизации: предложение при запуске и управление модами профиля. Используется страницами play и versions. */
(function () {
  'use strict';
  const { h, api } = EWL;

  const modList = (mods) => h('div', {}, mods.map((m) => h('div', { class: 'mod-row' }, h('div', {}, h('b', { text: m.name }), h('span', { text: m.desc })))));

  function reportResult(opt) {
    if (!opt) return;
    EWL.toast(`Оптимизация установлена: модов ${opt.installed.length}`, 'ok');
    if (opt.skipped && opt.skipped.length) {
      EWL.toast(`Пропущено: ${opt.skipped.map((x) => `${x.name} (${x.reason})`).join('; ')}`, 'warn', 9000);
    }
  }

  async function refreshAll() {
    await EWL.refresh.installed();
    document.dispatchEvent(new CustomEvent('ewl:data'));
  }

  /**
   * Предлагает оптимизацию перед запуском. Возвращает { action: 'continue' } или { action: 'switch', id } —
   * когда создан новый оптимизированный профиль и играть нужно в нём.
   */
  EWL.offerOptimization = async function offerOptimization(versionId) {
    const s = EWL.state.settings;
    if (!s.optimizeAsk || (s.optimizeDeclined || []).includes(versionId)) return { action: 'continue' };
    let st;
    try { st = await api('opt:status', versionId); } catch (_) { return { action: 'continue' }; }
    if ((st.supported && st.installed) || (!st.supported && !st.canCreateProfile)) return { action: 'continue' };

    return new Promise((resolve) => {
      const info = st.supported
        ? `Для профиля ${versionId} можно установить моды производительности. Они не меняют геймплей — только ускоряют игру.`
        : `Для чистой версии ${st.mc} можно создать оптимизированный профиль: Fabric + моды производительности. Он будет жить в отдельной папке со своими модами и настройками, ваши миры в обычной версии не пострадают.`;
      const note = h('p', { class: 'hint', text: 'Моды скачиваются с Modrinth, каждый файл проверяется по контрольной сумме. Удалить их можно в разделе «Версии».' });
      let busy = false;
      const buttons = [];
      const setBusy = (v) => { busy = v; buttons.forEach((b) => { b.disabled = v; }); };
      const dlg = EWL.modal({
        title: 'Ускорить Minecraft?',
        dismissable: false,
        body: [h('p', { text: info }), modList(st.available), note],
        actions: [],
      });
      const mk = (label, kind, fn) => {
        const b = h('button', { class: `btn ${kind}`, text: label, onclick: async () => { if (!busy) await fn(); } });
        buttons.push(b);
        return b;
      };
      const finish = (res) => { dlg.close(); resolve(res); };

      const optimizeBtn = mk(st.supported ? 'Установить' : 'Создать профиль', 'primary', async () => {
        setBusy(true);
        optimizeBtn.textContent = 'Устанавливаю…';
        try {
          if (st.supported) {
            reportResult(await api('opt:install', versionId));
            finish({ action: 'continue' });
          } else {
            const r = await api('opt:createProfile', { mc: st.mc });
            await refreshAll();
            reportResult(r.optimization);
            finish({ action: 'switch', id: r.id });
          }
        } catch (e) {
          if (!/отмен/i.test(e.message)) EWL.fail(e);
          setBusy(false);
          optimizeBtn.textContent = st.supported ? 'Установить' : 'Создать профиль';
        }
      });
      const skipBtn = mk('Без оптимизации', '', async () => finish({ action: 'continue' }));
      const neverBtn = mk('Больше не предлагать', 'ghost', async () => {
        try { EWL.state.settings.optimizeDeclined = await api('opt:decline', versionId); } catch (e) { EWL.fail(e); }
        finish({ action: 'continue' });
      });
      dlg.body.parentElement.append(h('div', { class: 'modal-actions' }, neverBtn, skipBtn, optimizeBtn));
    });
  };

  /** Окно управления оптимизацией профиля (раздел «Версии»). */
  EWL.manageOptimization = async function manageOptimization(versionId) {
    let st;
    try { st = await api('opt:status', versionId); } catch (e) { EWL.fail(e); return; }
    if (!st.supported) { EWL.toast('Моды производительности доступны для профилей Fabric и Quilt.', 'warn'); return; }
    const body = h('div');
    const draw = (cur) => body.replaceChildren(
      cur.installed
        ? h('div', {}, h('p', { class: 'hint', text: 'Установлено лаунчером:' }),
          h('div', { class: 'mod-row' }, h('div', {}, cur.mods.map((m) => h('div', {}, h('b', { text: m.name }), h('span', { text: ` ${m.version}` }))))))
        : h('div', {}, h('p', { class: 'hint', text: 'Сейчас моды производительности не установлены. Будут добавлены:' }), modList(cur.available)));
    draw(st);
    const dlg = EWL.modal({
      title: `Оптимизация: ${versionId}`,
      body,
      actions: [
        { label: 'Закрыть', kind: 'ghost' },
        ...(st.installed ? [{
          label: 'Удалить моды', kind: 'danger',
          onClick: async (close) => {
            try { await api('opt:remove', versionId); EWL.toast('Моды оптимизации удалены', 'ok'); close(); document.dispatchEvent(new CustomEvent('ewl:data')); } catch (e) { EWL.fail(e); }
          },
        }] : []),
        {
          label: st.installed ? 'Обновить' : 'Установить', kind: 'primary',
          onClick: async (close) => {
            close();
            try { reportResult(await api('opt:install', versionId)); document.dispatchEvent(new CustomEvent('ewl:data')); } catch (e) { if (!/отмен/i.test(e.message)) EWL.fail(e); }
          },
        },
      ],
    });
    void dlg;
  };
})();
