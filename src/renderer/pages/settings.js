/* Страница «Настройки»: память, Java, папка игры, окно, Microsoft Client ID. Автосохранение. */
(function () {
  'use strict';
  const { h, api } = EWL;

  EWL.pages.settings = {
    title: 'Настройки',
    icon: '⚙',
    render(root) {
      const s = EWL.state.settings;
      const savedEl = h('span', { class: 'hint', text: '' });
      let timer = null;
      const pending = {};

      function save(patch) {
        Object.assign(pending, patch);
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const p = { ...pending };
          Object.keys(pending).forEach((k) => delete pending[k]);
          try {
            EWL.state.settings = await api('settings:update', p);
            savedEl.textContent = 'Сохранено ✓';
            setTimeout(() => { savedEl.textContent = ''; }, 1800);
            document.dispatchEvent(new CustomEvent('ewl:settings'));
          } catch (e) { EWL.fail(e); }
        }, 350);
      }

      const memOf = (mb) => `${mb} МБ (${(mb / 1024).toFixed(1)} ГБ)`;
      const ramMaxLbl = h('span', { text: memOf(s.ramMax) });
      const ramMinLbl = h('span', { text: memOf(s.ramMin) });
      const ramMax = h('input', { type: 'range', min: '1024', max: '16384', step: '256', value: s.ramMax });
      const ramMin = h('input', { type: 'range', min: '256', max: '8192', step: '256', value: s.ramMin });
      ramMax.addEventListener('input', () => { ramMaxLbl.textContent = memOf(Number(ramMax.value)); });
      ramMax.addEventListener('change', () => save({ ramMax: Number(ramMax.value) }));
      ramMin.addEventListener('input', () => { ramMinLbl.textContent = memOf(Number(ramMin.value)); });
      ramMin.addEventListener('change', () => save({ ramMin: Number(ramMin.value) }));
      api('app:info').then((info) => {
        const cap = Math.max(1024, Math.floor(info.totalMemMb / 256) * 256);
        ramMax.max = String(cap);
        ramMin.max = String(Math.max(256, Math.floor(cap / 2)));
        ramMax.value = s.ramMax;
        ramMin.value = s.ramMin;
        document.getElementById('set-mem-hint').textContent = `Всего памяти в компьютере: ${info.totalMemMb} МБ. Не отдавайте игре больше ~70%.`;
        document.getElementById('set-about').textContent = `EWLLauncher ${info.version} · ${info.platform}/${info.arch} · данные лаунчера: ${info.dataDir}`;
      }).catch(() => {});

      const javaPath = h('input', { type: 'text', placeholder: 'Авто (рекомендуется)', value: s.javaPath, onchange: (e) => save({ javaPath: e.target.value.trim() }) });
      const bundled = h('input', { type: 'checkbox', checked: s.useBundledJava, onchange: (e) => save({ useBundledJava: e.target.checked }) });
      const gameDir = h('input', { type: 'text', value: s.gameDir, onchange: (e) => save({ gameDir: e.target.value.trim() }) });
      const jvm = h('textarea', { placeholder: 'Например: -XX:+UseG1GC -XX:MaxGCPauseMillis=50', onchange: (e) => save({ jvmArgs: e.target.value }) });
      jvm.value = s.jvmArgs;
      const width = h('input', { type: 'number', min: '320', max: '7680', value: s.width, onchange: (e) => save({ width: Number(e.target.value) }) });
      const height = h('input', { type: 'number', min: '240', max: '4320', value: s.height, onchange: (e) => save({ height: Number(e.target.value) }) });
      const full = h('input', { type: 'checkbox', checked: s.fullscreen, onchange: (e) => save({ fullscreen: e.target.checked }) });
      const hide = h('input', { type: 'checkbox', checked: s.closeOnLaunch, onchange: (e) => save({ closeOnLaunch: e.target.checked }) });
      const clientId = h('input', { type: 'text', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', value: s.msClientId, onchange: (e) => save({ msClientId: e.target.value.trim() }) });

      async function pickDir() {
        const d = await api('dialog:pickFolder', gameDir.value).catch(EWL.fail);
        if (d) {
          gameDir.value = d;
          save({ gameDir: d });
          EWL.toast('Папка игры изменена. Версии нужно установить заново (старая папка не удаляется).', 'warn', 7000);
        }
      }

      async function pickJava() {
        const f = await api('dialog:pickFile', 'java').catch(EWL.fail);
        if (f) { javaPath.value = f; save({ javaPath: f }); }
      }

      async function detectJava() {
        const dlg = EWL.modal({ title: 'Найденная Java', body: h('p', { class: 'hint', text: 'Ищем Java на компьютере…' }), actions: [{ label: 'Закрыть', kind: 'ghost' }] });
        try {
          const list = await api('java:detect');
          dlg.body.replaceChildren(list.length
            ? h('div', { class: 'list' }, list.map((j) => h('div', { class: 'item' },
              h('div', { class: 'grow' }, h('div', { class: 'title', text: `Java ${j.major}  (${j.version})` }), h('div', { class: 'meta', text: j.path })),
              h('button', { class: 'btn small primary', text: 'Использовать', onclick: () => { javaPath.value = j.path; save({ javaPath: j.path }); dlg.close(); } }))))
            : h('p', { class: 'hint', text: 'Java не найдена. Это нормально: лаунчер сам скачает нужную Java от Mojang.' }));
        } catch (e) { dlg.close(); EWL.fail(e); }
      }

      const SWATCHES = ['#3ddc84', '#4da3ff', '#a96bff', '#ff6b9a', '#ffb347', '#29d3d3'];
      const accent = h('input', { type: 'color', value: s.accent || '#3ddc84' });
      accent.addEventListener('input', () => EWL.applyAccent(accent.value));
      accent.addEventListener('change', () => save({ accent: accent.value }));
      const swatches = h('div', { class: 'row' }, SWATCHES.map((c) => h('button', {
        class: 'btn small', style: `background:${c};border:0;width:30px;height:30px;padding:0;border-radius:50%`, title: c,
        onclick: () => { accent.value = c; EWL.applyAccent(c); save({ accent: c }); },
      })));
      const askOpt = h('input', { type: 'checkbox', checked: s.optimizeAsk, onchange: (e) => save({ optimizeAsk: e.target.checked }) });
      const resetDeclined = h('button', { class: 'btn small', text: 'Сбросить отказы', onclick: () => { save({ optimizeDeclined: [] }); EWL.toast('Предложения оптимизации снова включены для всех версий', 'ok'); } });

      const THEMES = [['dark', 'Тёмная (по умолчанию)'], ['midnight', 'Полночь'], ['amoled', 'AMOLED (чёрная)'], ['light', 'Светлая']];
      const themeSel = h('select', { onchange: () => { EWL.applyTheme(themeSel.value); save({ theme: themeSel.value }); } }, THEMES.map(([k, l]) => h('option', { value: k, text: l })));
      themeSel.value = s.theme || 'dark';
      const updChk = h('input', { type: 'checkbox', checked: s.checkUpdates !== false, onchange: (e) => save({ checkUpdates: e.target.checked }) });
      const cfKey = h('input', { type: 'password', placeholder: 'Ключ API CurseForge (необязательно)', value: s.curseforgeKey || '', autocomplete: 'off', spellcheck: 'false', onchange: () => save({ curseforgeKey: cfKey.value.trim() }) });
      const perfChk = h('input', { type: 'checkbox', checked: !!s.performanceMode, onchange: (e) => { EWL.applyPerf(e.target.checked); save({ performanceMode: e.target.checked }); } });
      const discordChk = h('input', { type: 'checkbox', checked: s.discordPresence !== false, onchange: (e) => save({ discordPresence: e.target.checked }) });
      const welcomeChk = h('input', { type: 'checkbox', checked: s.welcomeAnimation !== false, onchange: (e) => save({ welcomeAnimation: e.target.checked }) });
      const row = (input, label) => h('label', { class: 'check' }, input, h('span', { text: label }));

      root.append(
        h('div', { class: 'row' }, h('h1', { text: 'Настройки' }), h('div', { class: 'spacer' }), savedEl),
        h('p', { class: 'sub', text: 'Изменения сохраняются автоматически.' }),
        h('div', { class: 'grid two' },
          h('div', { class: 'card' },
            h('h2', { text: 'Память (RAM)' }),
            EWL.field('Максимум для игры (-Xmx)', h('div', {}, ramMaxLbl, ramMax)),
            EWL.field('Начальный объём (-Xms)', h('div', {}, ramMinLbl, ramMin)),
            h('div', { class: 'hint', id: 'set-mem-hint' })),
          h('div', { class: 'card' },
            h('h2', { text: 'Java' }),
            EWL.field('Путь к java.exe', h('div', { class: 'row' }, h('div', { style: 'flex:1' }, javaPath),
              h('button', { class: 'btn', text: 'Обзор', onclick: pickJava }),
              h('button', { class: 'btn ghost', text: 'Авто', onclick: () => { javaPath.value = ''; save({ javaPath: '' }); } }))),
            row(bundled, 'Автоматически скачивать нужную Java от Mojang'),
            h('button', { class: 'btn', text: 'Найти установленные Java', onclick: detectJava }))),
        h('div', { class: 'card' },
          h('h2', { text: 'Папка игры' }),
          EWL.field('Расположение', h('div', { class: 'row' }, h('div', { style: 'flex:1' }, gameDir),
            h('button', { class: 'btn', text: 'Выбрать', onclick: pickDir }),
            h('button', { class: 'btn ghost', text: 'Открыть', onclick: () => api('app:openPath', 'game').catch(EWL.fail) })),
          'Здесь лежат версии, библиотеки, ресурсы, миры, моды и сервер.')),
        h('div', { class: 'grid two' },
          h('div', { class: 'card' },
            h('h2', { text: 'Запуск' }),
            h('div', { class: 'grid two' }, EWL.field('Ширина окна', width), EWL.field('Высота окна', height)),
            row(full, 'Полноэкранный режим'),
            row(hide, 'Сворачивать лаунчер на время игры'),
            EWL.field('Дополнительные аргументы JVM', jvm)),
          h('div', { class: 'card' },
            h('h2', { text: 'Microsoft' }),
            EWL.field('Azure Client ID', clientId, 'Нужен для входа через Microsoft. Инструкция — кнопка ниже.'),
            h('button', { class: 'btn', text: 'Как получить Client ID', onclick: () => EWL.showMsHelp() })),
          h('div', { class: 'card' },
            h('h2', { text: 'CurseForge' }),
            EWL.field('Ключ API', cfKey, 'Нужен, чтобы искать моды в CurseForge. Хранится только на этом компьютере. Получить: console.curseforge.com → API keys.'),
            h('button', { class: 'btn small', text: 'Открыть console.curseforge.com', onclick: () => api('app:openExternal', 'https://console.curseforge.com/').catch(EWL.fail) }))),
        h('div', { class: 'grid two' },
          h('div', { class: 'card' },
            h('h2', { text: 'Внешний вид' }),
            EWL.field('Тема', themeSel),
            EWL.field('Акцентный цвет', h('div', { class: 'row' }, accent, swatches)),
            row(welcomeChk, 'Показывать приветствие с именем при входе в лаунчер'),
            row(perfChk, 'Режим производительности (без анимаций и теней, для слабых компьютеров)'),
            row(discordChk, 'Показывать в Discord, во что вы играете')),
          h('div', { class: 'card' },
            h('h2', { text: 'Оптимизация' }),
            h('label', { class: 'check' }, askOpt, h('span', { text: 'Предлагать моды производительности при запуске игры' })),
            resetDeclined)),
        h('div', { class: 'card' },
          h('div', { class: 'hint', id: 'set-about' }),
          h('div', { class: 'row', style: 'margin-top:10px' },
            h('button', { class: 'btn small', text: 'Открыть папку логов', onclick: () => api('app:openPath', 'logs').catch(EWL.fail) }),
            h('button', { class: 'btn small', text: 'Проверить обновления', onclick: () => EWL.checkUpdate({ quiet: false }) })),
          h('div', { style: 'margin-top:10px' }, row(updChk, 'Проверять обновления лаунчера при запуске'))),
      );
    },
  };
})();
