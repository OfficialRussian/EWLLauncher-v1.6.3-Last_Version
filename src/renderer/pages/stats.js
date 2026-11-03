/* Страница «Статистика»: время игры по сборкам и галерея скриншотов. */
(function () {
  'use strict';
  const { h, api } = EWL;

  const fmtTime = (ms) => {
    const m = Math.round(ms / 60000);
    if (m < 1) return ms >= 5000 ? 'меньше минуты' : '—';
    const hh = Math.floor(m / 60);
    return hh ? `${hh} ч ${m % 60} мин` : `${m} мин`;
  };
  const fmtWhen = (ms) => { try { return new Date(ms).toLocaleString('ru-RU'); } catch (_) { return ''; } };

  EWL.pages.stats = {
    title: 'Статистика',
    icon: '📊',
    render(root) {
      const statsEl = h('div', { class: 'card' }, h('div', { class: 'hint', text: 'Загрузка…' }));
      const gallery = h('div', { class: 'shots' });
      const galleryCard = h('div', { class: 'card' });

      const nameOf = (id) => {
        const v = EWL.state.installed.find((x) => x.id === id);
        return v ? EWL.displayName(v) : id;
      };

      async function loadStats() {
        let s;
        try { s = await api('app:stats'); } catch (e) { EWL.fail(e); return; }
        const rows = s.rows.map((r) => h('div', { class: 'item' },
          h('div', { class: 'grow' }, h('div', { class: 'title', text: nameOf(r.id) }), h('div', { class: 'meta', text: `Запусков: ${r.launches}${r.last ? ` · последний ${fmtWhen(r.last)}` : ''}` })),
          h('span', { class: 'badge ok', text: fmtTime(r.playMs) })));
        statsEl.replaceChildren(
          h('h2', { text: 'Время в игре' }),
          h('p', { class: 'hint', text: s.rows.length ? `Всего: ${fmtTime(s.totalMs)} · запусков: ${s.totalLaunches}` : 'Пока пусто. Статистика копится после первого запуска игры (меньше 5 секунд не считается).' }),
          h('div', { class: 'list' }, rows));
      }

      async function loadShots() {
        let r;
        try { r = await api('app:screenshots'); } catch (e) { EWL.fail(e); return; }
        gallery.replaceChildren();
        if (!r.items.length) gallery.append(h('div', { class: 'empty', text: 'Скриншотов пока нет. В игре нажмите F2 — снимок появится здесь.' }));
        for (const s of r.items) {
          gallery.append(h('div', { class: 'shot' },
            s.thumb ? h('img', { src: s.thumb, alt: '', onclick: () => api('app:screenshotOpen', { profile: s.profile, file: s.file }).catch(EWL.fail) }) : h('div', { class: 'shot-ph', text: 'нет превью' }),
            h('div', { class: 'meta', text: `${s.profile ? nameOf(s.profile) : 'Обычные версии'} · ${fmtWhen(s.mtime)}` }),
            h('button', { class: 'btn small danger', text: 'Удалить', onclick: async () => {
              if (!(await EWL.confirm('Удалить скриншот? Это нельзя отменить.', 'Удалить'))) return;
              try { await api('app:screenshotDelete', { profile: s.profile, file: s.file }); loadShots(); } catch (e) { EWL.fail(e); }
            } })));
        }
        galleryCard.querySelector('.count').textContent = r.total > r.items.length ? `Показаны последние ${r.items.length} из ${r.total}` : `Всего: ${r.total}`;
      }

      galleryCard.append(
        h('div', { class: 'row' }, h('h2', { text: 'Скриншоты', style: 'margin:0' }), h('div', { class: 'spacer' }),
          h('span', { class: 'hint count' }),
          h('button', { class: 'btn small', text: 'Открыть папку', onclick: () => api('app:screenshotFolder').catch(EWL.fail) })),
        gallery);

      root.append(h('h1', { text: 'Статистика' }), h('p', { class: 'sub', text: 'Сколько вы играли и ваши скриншоты.' }), statsEl, galleryCard);
      EWL.refresh.installed().then(() => { loadStats(); loadShots(); });
    },
  };
})();
