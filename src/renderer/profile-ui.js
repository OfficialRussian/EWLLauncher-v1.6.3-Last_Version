/* Окна работы со сборкой: личные настройки памяти/Java и бэкапы миров. */
(function () {
  'use strict';
  const { h, api } = EWL;

  const fmtSize = (b) => {
    if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} ГБ`;
    if (b >= 1048576) return `${(b / 1048576).toFixed(1)} МБ`;
    return `${Math.max(1, Math.round(b / 1024))} КБ`;
  };
  const fmtWhen = (ms) => { try { return new Date(ms).toLocaleString('ru-RU'); } catch (_) { return ''; } };

  /** Память и JVM-аргументы только для этой сборки (поверх общих настроек). */
  EWL.profileSettings = async function profileSettings(v) {
    let cfg; let info;
    try { [cfg, info] = await Promise.all([api('profile:getConfig', v.id), api('app:info')]); } catch (e) { EWL.fail(e); return; }
    const cap = Math.max(1024, Math.floor(info.totalMemMb / 256) * 256);
    const global = EWL.state.settings.ramMax;
    const own = h('input', { type: 'checkbox' });
    own.checked = !!cfg.ramMax;
    const slider = h('input', { type: 'range', min: '1024', max: String(cap), step: '256', value: String(Math.min(cap, cfg.ramMax || global)) });
    const label = h('span', { class: 'hint' });
    const jvm = h('textarea', { placeholder: 'Например: -XX:+UseG1GC (добавляется к общим аргументам)' });
    jvm.value = cfg.jvmArgs || '';
    const sync = () => {
      slider.disabled = !own.checked;
      label.textContent = own.checked ? `${slider.value} МБ для этой сборки` : `Как в общих настройках: ${global} МБ`;
    };
    own.addEventListener('change', sync);
    slider.addEventListener('input', sync);
    sync();
    EWL.modal({
      title: `Настройки сборки «${EWL.displayName(v)}»`,
      body: [
        h('p', { class: 'hint', text: 'Тяжёлым сборкам (много модов, шейдеры) нужно больше памяти, лёгким — меньше. Эти значения действуют только на эту сборку.' }),
        h('label', { class: 'check' }, own, h('span', { text: 'Своё ограничение памяти (-Xmx)' })),
        h('div', { class: 'row' }, slider, label),
        h('p', { class: 'hint', text: `Всего памяти в компьютере: ${info.totalMemMb} МБ. Не отдавайте игре больше ~70%.` }),
        EWL.field('Дополнительные JVM-аргументы', jvm),
      ],
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Сохранить', kind: 'primary',
          onClick: async (close) => {
            try {
              await api('profile:setConfig', { id: v.id, ramMax: own.checked ? Number(slider.value) : 0, jvmArgs: jvm.value });
              close();
              EWL.toast('Настройки сборки сохранены', 'ok');
            } catch (e) { EWL.fail(e); }
          },
        },
      ],
    });
  };

  /** Бэкапы миров сборки: создать, восстановить, удалить. */
  EWL.profileBackups = async function profileBackups(v) {
    const listEl = h('div', { class: 'list' });
    const worldsEl = h('div', { class: 'hint' });
    let busy = false;

    async function draw() {
      let worlds = []; let backups = [];
      try { [worlds, backups] = await Promise.all([api('profile:worlds', v.id), api('profile:backups', v.id)]); } catch (e) { EWL.fail(e); }
      worldsEl.textContent = worlds.length
        ? `Миры сейчас: ${worlds.map((w) => `${w.name} (${fmtSize(w.size)})`).join(', ')}`
        : 'В этой сборке пока нет миров.';
      listEl.replaceChildren();
      if (!backups.length) listEl.append(h('div', { class: 'empty', text: 'Бэкапов ещё нет.' }));
      for (const b of backups) {
        listEl.append(h('div', { class: 'item' },
          h('div', { class: 'grow' },
            h('div', { class: 'title', text: fmtWhen(b.mtime) }),
            h('div', { class: 'meta', text: `${b.file} · ${fmtSize(b.size)}` })),
          h('button', { class: 'btn small', text: 'Восстановить', disabled: busy, onclick: () => restore(b) }),
          h('button', { class: 'btn small danger', text: 'Удалить', disabled: busy, onclick: () => del(b) })));
      }
    }

    async function make() {
      if (busy) return;
      busy = true;
      EWL.toast('Создаю бэкап…', 'info');
      try {
        const r = await api('profile:backup', { id: v.id });
        EWL.toast(`Бэкап готов: ${r.worlds.length} мир(ов), ${fmtSize(r.size)}`, 'ok');
      } catch (e) { EWL.fail(e); } finally { busy = false; draw(); }
    }
    function restore(b) {
      EWL.modal({
        title: 'Восстановить миры',
        body: [h('p', { text: `Восстановить миры из бэкапа от ${fmtWhen(b.mtime)}?` }),
          h('p', { class: 'hint', text: 'Если мир с таким именем уже есть, он не пропадёт: будет переименован в «…до-восстановления…».' })],
        actions: [{ label: 'Отмена', kind: 'ghost' }, {
          label: 'Восстановить', kind: 'primary',
          onClick: async (close) => {
            close();
            try {
              const r = await api('profile:restore', { id: v.id, file: b.file });
              EWL.toast(`Восстановлено миров: ${r.worlds.length}${r.kept.length ? ` (старые сохранены: ${r.kept.length})` : ''}`, 'ok');
            } catch (e) { EWL.fail(e); } finally { draw(); }
          },
        }],
      });
    }
    function del(b) {
      EWL.modal({
        title: 'Удалить бэкап', dismissable: false,
        body: [h('p', { text: `Удалить бэкап от ${fmtWhen(b.mtime)} (${fmtSize(b.size)})? Это нельзя отменить.` })],
        actions: [{ label: 'Отмена', kind: 'ghost' }, {
          label: 'Удалить', kind: 'danger',
          onClick: async (close) => { close(); try { await api('profile:removeBackup', { id: v.id, file: b.file }); } catch (e) { EWL.fail(e); } draw(); },
        }],
      });
    }

    EWL.modal({
      title: `Бэкапы миров: «${EWL.displayName(v)}»`,
      body: [
        h('p', { class: 'hint', text: 'Копия всех миров в один архив. Делайте её перед обновлением модов или экспериментами.' }),
        worldsEl,
        h('div', { class: 'row', style: 'margin:12px 0' },
          h('button', { class: 'btn primary', text: 'Создать бэкап', onclick: make }),
          h('button', { class: 'btn ghost', text: 'Открыть папку бэкапов', onclick: () => api('app:openPath', 'backups', v.id).catch(EWL.fail) })),
        listEl,
      ],
      actions: [{ label: 'Закрыть', kind: 'primary' }],
    });
    draw();
  };
})();
