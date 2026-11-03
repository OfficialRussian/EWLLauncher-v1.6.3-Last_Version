/* Страница «Скины»: пиксельный редактор скина 64×64, превью со всех сторон, библиотека, загрузка в аккаунт Microsoft. */
(function () {
  'use strict';
  const { h, api } = EWL;

  const SIZE = 64;
  const ZOOM = 8; // размер пикселя скина на экране

  // ---------- раскладка текстуры (стандарт Minecraft 1.8+, 64×64) ----------
  // Часть тела = коробка w×h×d с началом (ox, oy) для основного слоя и (oox, ooy) для внешнего (шапка, куртка, рукава, штаны).
  const armW = (slim) => (slim ? 3 : 4);
  function parts(slim) {
    return {
      head: { w: 8, h: 8, d: 8, base: [0, 0], over: [32, 0], label: 'Голова' },
      body: { w: 8, h: 12, d: 4, base: [16, 16], over: [16, 32], label: 'Тело' },
      rArm: { w: armW(slim), h: 12, d: 4, base: [40, 16], over: [40, 32], label: 'Правая рука' },
      lArm: { w: armW(slim), h: 12, d: 4, base: [32, 48], over: [48, 48], label: 'Левая рука' },
      rLeg: { w: 4, h: 12, d: 4, base: [0, 16], over: [0, 32], label: 'Правая нога' },
      lLeg: { w: 4, h: 12, d: 4, base: [16, 48], over: [0, 48], label: 'Левая нога' },
    };
  }

  /** Прямоугольник грани коробки на текстуре: [x, y, ширина, высота]. */
  function face(part, origin, which) {
    const [ox, oy] = origin;
    const { w, h: ht, d } = part;
    switch (which) {
      case 'top': return [ox + d, oy, w, d];
      case 'bottom': return [ox + d + w, oy, w, d];
      case 'right': return [ox, oy + d, d, ht];
      case 'front': return [ox + d, oy + d, w, ht];
      case 'left': return [ox + d + w, oy + d, d, ht];
      default: return [ox + 2 * d + w, oy + d, w, ht]; // back
    }
  }

  // Положение частей на силуэте (в пикселях скина). Силуэт спереди: 16 × 32.
  function layout(view, slim) {
    const P = parts(slim);
    const aw = armW(slim);
    if (view === 'front') {
      return [
        ['rLeg', 'front', 4, 20], ['lLeg', 'front', 8, 20], ['body', 'front', 4, 8],
        ['rArm', 'front', 4 - aw, 8], ['lArm', 'front', 12, 8], ['head', 'front', 4, 0],
      ].map(([k, f, x, y]) => ({ part: P[k], face: f, x, y }));
    }
    if (view === 'back') {
      return [
        ['lLeg', 'back', 4, 20], ['rLeg', 'back', 8, 20], ['body', 'back', 4, 8],
        ['lArm', 'back', 4 - aw, 8], ['rArm', 'back', 12, 8], ['head', 'back', 4, 0],
      ].map(([k, f, x, y]) => ({ part: P[k], face: f, x, y }));
    }
    const side = view === 'right' ? 'right' : 'left'; // вид справа / слева, силуэт 8 × 32
    const leg = view === 'right' ? 'rLeg' : 'lLeg';
    const arm = view === 'right' ? 'rArm' : 'lArm';
    return [
      [leg, 2, 20], ['body', 2, 8], ['head', 0, 0], [arm, 2, 8],
    ].map(([k, x, y]) => ({ part: P[k], face: side, x, y }));
  }

  const VIEWS = [['front', 'Спереди', 16], ['right', 'Справа', 8], ['back', 'Сзади', 16], ['left', 'Слева', 8]];

  // ---------- цвета ----------
  const PALETTE = [
    '#f1c8a0', '#e0a97c', '#c58c5f', '#8d5a3b', '#5b3a24', '#2b1b10',
    '#f2d16b', '#d9a441', '#b5651d', '#7a3b12', '#e8e8e8', '#9aa0a6',
    '#5c5c5c', '#222222', '#ff5a5a', '#c62828', '#ff9f43', '#ffd93d',
    '#6bd66b', '#2e9e4f', '#1b5e20', '#4dd2d2', '#2fb8c7', '#4da3ff',
    '#3a4ea6', '#1a237e', '#a96bff', '#6a2fc4', '#ff6b9a', '#c2185b',
  ];

  const hex2rgb = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    const v = m ? m[1] : '000000';
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  };

  // ---------- страница ----------
  EWL.pages.skins = {
    title: 'Скины',
    icon: '🎨',
    render(root) {
      const tex = document.createElement('canvas');
      tex.width = SIZE; tex.height = SIZE;
      const tctx = tex.getContext('2d', { willReadFrequently: true });

      const view = h('canvas', { class: 'skin-canvas', width: SIZE * ZOOM, height: SIZE * ZOOM });
      const vctx = view.getContext('2d');
      const labels = h('canvas', { class: 'skin-canvas skin-labels', width: SIZE * ZOOM, height: SIZE * ZOOM });
      const lctx = labels.getContext('2d');

      let tool = 'pencil';
      let brush = 1;
      let color = '#c58c5f';
      let slim = false;
      let grid = true;
      let showLabels = false;
      let dirty = false;
      const undo = [];
      const redo = [];
      const recent = [];

      // ----- рисование -----
      const snapshot = () => tctx.getImageData(0, 0, SIZE, SIZE);
      function pushUndo() {
        undo.push(snapshot());
        if (undo.length > 60) undo.shift();
        redo.length = 0;
        dirty = true;
        syncButtons();
      }
      function restore(img) { tctx.putImageData(img, 0, 0); redrawAll(); }
      function doUndo() { if (!undo.length) return; redo.push(snapshot()); restore(undo.pop()); syncButtons(); }
      function doRedo() { if (!redo.length) return; undo.push(snapshot()); restore(redo.pop()); syncButtons(); }

      function checker(ctx, w, hh, cell) {
        for (let y = 0; y < hh; y += cell) {
          for (let x = 0; x < w; x += cell) {
            ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? '#3a4156' : '#2c3245';
            ctx.fillRect(x, y, cell, cell);
          }
        }
      }

      function redrawEditor() {
        checker(vctx, view.width, view.height, ZOOM * 2);
        vctx.imageSmoothingEnabled = false;
        vctx.drawImage(tex, 0, 0, view.width, view.height);
        if (grid) {
          vctx.strokeStyle = 'rgba(255,255,255,.07)';
          vctx.lineWidth = 1;
          vctx.beginPath();
          for (let i = 1; i < SIZE; i++) {
            vctx.moveTo(i * ZOOM + 0.5, 0); vctx.lineTo(i * ZOOM + 0.5, view.height);
            vctx.moveTo(0, i * ZOOM + 0.5); vctx.lineTo(view.width, i * ZOOM + 0.5);
          }
          vctx.stroke();
        }
      }

      function redrawLabels() {
        lctx.clearRect(0, 0, labels.width, labels.height);
        if (!showLabels) return;
        const P = parts(slim);
        lctx.font = '600 11px system-ui, sans-serif';
        lctx.textBaseline = 'top';
        for (const p of Object.values(P)) {
          for (const [layer, o] of [['', p.base], [' (внеш.)', p.over]]) {
            const x = o[0] * ZOOM; const y = o[1] * ZOOM;
            const w = (2 * p.d + 2 * p.w) * ZOOM; const hh = (p.d + p.h) * ZOOM;
            lctx.strokeStyle = layer ? 'rgba(255,196,71,.75)' : 'rgba(98,176,255,.85)';
            lctx.lineWidth = 1.5;
            lctx.strokeRect(x + 0.5, y + 0.5, w, hh);
            lctx.fillStyle = layer ? 'rgba(255,196,71,.95)' : 'rgba(150,205,255,.98)';
            lctx.fillText(`${p.label}${layer}`, x + 4, y + 2);
          }
        }
      }

      function drawBody(ctx, kind, scale, withOver) {
        ctx.imageSmoothingEnabled = false;
        const items = layout(kind, slim);
        for (const layerOver of withOver ? [false, true] : [false]) {
          for (const it of items) {
            const o = layerOver ? it.part.over : it.part.base;
            const [sx, sy, sw, sh] = face(it.part, o, it.face);
            ctx.drawImage(tex, sx, sy, sw, sh, it.x * scale, it.y * scale, sw * scale, sh * scale);
          }
        }
      }

      const previews = VIEWS.map(([kind, label, wUnits]) => {
        const scale = 5;
        const cv = h('canvas', { class: 'skin-prev', width: wUnits * scale, height: 32 * scale });
        return { kind, label, scale, cv };
      });
      function redrawPreviews() {
        for (const p of previews) {
          const ctx = p.cv.getContext('2d');
          ctx.clearRect(0, 0, p.cv.width, p.cv.height);
          drawBody(ctx, p.kind, p.scale, true);
        }
      }

      function redrawAll() { redrawEditor(); redrawLabels(); redrawPreviews(); }
      // При рисовании мышью событий бывает сотни в секунду: перерисовываем не чаще одного раза за кадр.
      let redrawFrame = 0;
      function scheduleRedraw() {
        if (redrawFrame) return;
        redrawFrame = requestAnimationFrame(() => { redrawFrame = 0; redrawAll(); });
      }

      // ----- инструменты -----
      function setPixel(x, y, erase) {
        const o = Math.floor((brush - 1) / 2);
        const x0 = Math.max(0, x - o);
        const y0 = Math.max(0, y - o);
        const w = Math.min(brush, SIZE - x0);
        const hh = Math.min(brush, SIZE - y0);
        tctx.clearRect(x0, y0, w, hh);
        if (!erase) { tctx.fillStyle = color; tctx.fillRect(x0, y0, w, hh); }
      }

      function line(x0, y0, x1, y1, erase) {
        const dx = Math.abs(x1 - x0); const dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1; const sy = y0 < y1 ? 1 : -1;
        let err = dx + dy; let x = x0; let y = y0;
        for (;;) {
          setPixel(x, y, erase);
          if (x === x1 && y === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x += sx; }
          if (e2 <= dx) { err += dx; y += sy; }
        }
      }

      function floodFill(x, y) {
        const img = tctx.getImageData(0, 0, SIZE, SIZE);
        const d = img.data;
        const at = (px, py) => (py * SIZE + px) * 4;
        const i0 = at(x, y);
        const target = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
        const [r, g, b] = hex2rgb(color);
        if (target[0] === r && target[1] === g && target[2] === b && target[3] === 255) return;
        const same = (i) => d[i] === target[0] && d[i + 1] === target[1] && d[i + 2] === target[2] && d[i + 3] === target[3];
        const stack = [[x, y]];
        while (stack.length) {
          const [px, py] = stack.pop();
          if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) continue;
          const i = at(px, py);
          if (!same(i)) continue;
          d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
          stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
        }
        tctx.putImageData(img, 0, 0);
      }

      function pick(x, y) {
        const p = tctx.getImageData(x, y, 1, 1).data;
        if (p[3] === 0) { EWL.toast('Пиксель прозрачный', 'info', 1500); return; }
        setColor(`#${[p[0], p[1], p[2]].map((n) => n.toString(16).padStart(2, '0')).join('')}`);
        setTool('pencil');
      }

      function remember(c) {
        const i = recent.indexOf(c);
        if (i >= 0) recent.splice(i, 1);
        recent.unshift(c);
        if (recent.length > 10) recent.pop();
        drawRecent();
      }

      let painting = false;
      let last = null;
      const cell = (e) => {
        const r = view.getBoundingClientRect();
        const x = Math.floor(((e.clientX - r.left) / r.width) * SIZE);
        const y = Math.floor(((e.clientY - r.top) / r.height) * SIZE);
        return [Math.max(0, Math.min(SIZE - 1, x)), Math.max(0, Math.min(SIZE - 1, y))];
      };

      view.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const [x, y] = cell(e);
        if (tool === 'picker') { pick(x, y); return; }
        pushUndo();
        if (tool === 'fill') { floodFill(x, y); remember(color); redrawAll(); return; }
        painting = true;
        last = [x, y];
        view.setPointerCapture(e.pointerId);
        setPixel(x, y, tool === 'eraser');
        if (tool === 'pencil') remember(color);
        redrawAll();
      });
      view.addEventListener('pointermove', (e) => {
        const [x, y] = cell(e);
        coord.textContent = `x ${x}, y ${y}`;
        if (!painting) return;
        line(last[0], last[1], x, y, tool === 'eraser');
        last = [x, y];
        scheduleRedraw();
      });
      const stop = () => { painting = false; last = null; };
      view.addEventListener('pointerup', stop);
      view.addEventListener('pointercancel', stop);
      view.addEventListener('pointerleave', () => { coord.textContent = ''; });

      // ----- шаблон и загрузка -----
      function fillFace(p, origin, which, c) {
        const [x, y, w, hh] = face(p, origin, which);
        tctx.fillStyle = c;
        tctx.fillRect(x, y, w, hh);
      }

      function defaultSkin() {
        tctx.clearRect(0, 0, SIZE, SIZE);
        const P = parts(slim);
        const SKIN = '#c58c5f'; const HAIR = '#3b2a1a'; const SHIRT = '#2fb8c7'; const PANTS = '#3a4ea6'; const SHOE = '#5c5c5c';
        const FACES = ['top', 'bottom', 'right', 'front', 'left', 'back'];
        for (const f of FACES) {
          fillFace(P.head, P.head.base, f, SKIN);
          fillFace(P.body, P.body.base, f, SHIRT);
          for (const k of ['rArm', 'lArm']) fillFace(P[k], P[k].base, f, SKIN);
          for (const k of ['rLeg', 'lLeg']) fillFace(P[k], P[k].base, f, PANTS);
        }
        // волосы: верх головы и две верхние строки боковых граней
        fillFace(P.head, P.head.base, 'top', HAIR);
        for (const f of ['right', 'front', 'left', 'back']) {
          const [x, y, w] = face(P.head, P.head.base, f);
          tctx.fillStyle = HAIR; tctx.fillRect(x, y, w, 2);
        }
        { // лицо
          const [x, y] = face(P.head, P.head.base, 'front');
          const px = (dx, dy, c) => { tctx.fillStyle = c; tctx.fillRect(x + dx, y + dy, 1, 1); };
          px(1, 4, '#ffffff'); px(2, 4, '#4a5fd0'); px(5, 4, '#4a5fd0'); px(6, 4, '#ffffff');
          px(3, 6, '#8a4b3a'); px(4, 6, '#8a4b3a');
        }
        // рукава футболки и ботинки
        for (const k of ['rArm', 'lArm']) {
          for (const f of ['right', 'front', 'left', 'back']) {
            const [x, y, w] = face(P[k], P[k].base, f);
            tctx.fillStyle = SHIRT; tctx.fillRect(x, y, w, 4);
          }
          fillFace(P[k], P[k].base, 'top', SHIRT);
        }
        for (const k of ['rLeg', 'lLeg']) {
          for (const f of ['right', 'front', 'left', 'back']) {
            const [x, y, w, hh] = face(P[k], P[k].base, f);
            tctx.fillStyle = SHOE; tctx.fillRect(x, y + hh - 2, w, 2);
          }
          fillFace(P[k], P[k].base, 'bottom', SHOE);
        }
      }

      /** Старые скины 64×32 → 64×64: левые конечности зеркалят правые. */
      function upgradeLegacy() {
        const mirror = (sx, sy, dx, dy) => {
          // [откуда относительно начала, куда относительно начала, ширина, высота] по граням коробки 4×12×4
          const map = [[4, 0, 4, 0, 4, 4], [8, 0, 8, 0, 4, 4], [0, 4, 8, 4, 4, 12], [4, 4, 4, 4, 4, 12], [8, 4, 0, 4, 4, 12], [12, 4, 12, 4, 4, 12]];
          for (const [fx, fy, tx, ty, w, hh] of map) {
            const src = tctx.getImageData(sx + fx, sy + fy, w, hh);
            const out = tctx.createImageData(w, hh);
            for (let y = 0; y < hh; y++) {
              for (let x = 0; x < w; x++) {
                const a = (y * w + (w - 1 - x)) * 4; const b = (y * w + x) * 4;
                out.data[b] = src.data[a]; out.data[b + 1] = src.data[a + 1]; out.data[b + 2] = src.data[a + 2]; out.data[b + 3] = src.data[a + 3];
              }
            }
            tctx.putImageData(out, dx + tx, dy + ty);
          }
        };
        mirror(0, 16, 16, 48); // нога
        mirror(40, 16, 32, 48); // рука
      }

      function loadDataUrl(dataUrl, name) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            if (img.width !== SIZE || (img.height !== SIZE && img.height !== 32)) { reject(new Error('Размер скина должен быть 64×64 или 64×32.')); return; }
            pushUndo();
            tctx.clearRect(0, 0, SIZE, SIZE);
            tctx.drawImage(img, 0, 0);
            if (img.height === 32) upgradeLegacy();
            if (name) nameInput.value = name;
            redrawAll();
            resolve();
          };
          img.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
          img.src = dataUrl;
        });
      }

      const currentDataUrl = () => tex.toDataURL('image/png');

      // ----- элементы управления -----
      const coord = h('span', { class: 'hint mono', text: '' });
      const colorInput = h('input', { type: 'color', value: color, oninput: (e) => { color = e.target.value; hexInput.value = color; } });
      const hexInput = h('input', { type: 'text', value: color, maxlength: '7', class: 'hex', onchange: (e) => { const v = e.target.value.trim(); if (/^#[0-9a-f]{6}$/i.test(v)) setColor(v.toLowerCase()); else e.target.value = color; } });
      function setColor(c) { color = c; colorInput.value = c; hexInput.value = c; }

      const toolBtns = {};
      const TOOLS = [['pencil', '✏ Карандаш'], ['eraser', '⌫ Ластик'], ['fill', '▣ Заливка'], ['picker', '⦿ Пипетка']];
      function setTool(t) { tool = t; for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('active', k === t); }
      const toolBar = h('div', { class: 'seg' }, TOOLS.map(([k, label]) => {
        toolBtns[k] = h('button', { class: `seg-btn ${k === tool ? 'active' : ''}`, text: label, onclick: () => setTool(k) });
        return toolBtns[k];
      }));

      const brushSel = h('select', { onchange: (e) => { brush = Number(e.target.value); } },
        [1, 2, 3].map((n) => h('option', { value: String(n), text: `Кисть ${n}×${n}` })));

      const palette = h('div', { class: 'palette' }, PALETTE.map((c) => h('button', { class: 'swatch', style: `background:${c}`, title: c, onclick: () => { setColor(c); if (tool === 'picker' || tool === 'eraser') setTool('pencil'); } })));
      const recentEl = h('div', { class: 'palette' });
      function drawRecent() {
        recentEl.replaceChildren(...recent.map((c) => h('button', { class: 'swatch', style: `background:${c}`, title: c, onclick: () => setColor(c) })));
      }

      const undoBtn = h('button', { class: 'btn small', text: '↶ Отменить', onclick: doUndo });
      const redoBtn = h('button', { class: 'btn small', text: '↷ Вернуть', onclick: doRedo });
      function syncButtons() { undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length; }

      const modelSeg = h('div', { class: 'seg' });
      function drawModel() {
        modelSeg.replaceChildren(...[['classic', 'Классическая (руки 4 px)'], ['slim', 'Тонкая (руки 3 px)']].map(([k, label]) => h('button', {
          class: `seg-btn ${(slim ? 'slim' : 'classic') === k ? 'active' : ''}`, text: label,
          onclick: () => { slim = k === 'slim'; drawModel(); redrawAll(); },
        })));
      }

      const gridChk = h('input', { type: 'checkbox', checked: true, onchange: (e) => { grid = e.target.checked; redrawEditor(); } });
      const labelChk = h('input', { type: 'checkbox', onchange: (e) => { showLabels = e.target.checked; redrawLabels(); } });

      const nameInput = h('input', { type: 'text', maxlength: '40', placeholder: 'Название скина', value: 'Мой скин' });

      async function newSkin() {
        if (dirty && !(await EWL.confirm('Заменить текущий рисунок шаблоном? Это действие можно отменить кнопкой «Отменить».', 'Заменить'))) return;
        pushUndo(); defaultSkin(); redrawAll();
      }
      async function clearAll() {
        if (!(await EWL.confirm('Очистить весь скин? Это действие можно отменить кнопкой «Отменить».', 'Очистить'))) return;
        pushUndo(); tctx.clearRect(0, 0, SIZE, SIZE); redrawAll();
      }
      async function doImport() {
        try { const url = await api('skin:import'); if (url) await loadDataUrl(url); } catch (e) { EWL.fail(e); }
      }
      async function doExport() {
        try { if (await api('skin:export', { name: nameInput.value || 'skin', dataUrl: currentDataUrl() })) EWL.toast('PNG сохранён', 'ok'); } catch (e) { EWL.fail(e); }
      }
      async function doSave() {
        try {
          const name = await api('skin:save', { name: nameInput.value, dataUrl: currentDataUrl() });
          dirty = false;
          EWL.toast(`Скин «${name}» сохранён в библиотеку`, 'ok');
          loadLibrary();
        } catch (e) { EWL.fail(e); }
      }

      // ----- аккаунт Microsoft -----
      const msBox = h('div', { class: 'card' });
      function selectedAccount() { return EWL.state.accounts.find((a) => a.id === EWL.state.selectedId); }
      function drawMs() {
        const acc = selectedAccount();
        if (!acc) {
          msBox.replaceChildren(h('h2', { text: 'Скин в игре' }), h('p', { class: 'hint', text: 'Добавьте аккаунт в разделе «Аккаунты».' }));
          return;
        }
        if (acc.type !== 'microsoft') {
          msBox.replaceChildren(h('h2', { text: 'Скин в игре' }),
            h('p', { class: 'hint', text: `Аккаунт ${acc.name} — офлайн: у него нет профиля Mojang, поэтому скин на серверах не отображается. Сохраните PNG: он пригодится, если позже войдёте через Microsoft.` }),
            h('button', { class: 'btn', text: 'К аккаунтам', onclick: () => EWL.go('accounts') }));
          return;
        }
        msBox.replaceChildren(h('h2', { text: 'Скин аккаунта Microsoft' }),
          h('p', { class: 'hint', text: `Аккаунт: ${acc.name}. Загруженный скин увидят все игроки на серверах с проверкой лицензии.` }),
          h('div', { class: 'row' },
            h('button', { class: 'btn', text: 'Взять текущий скин', onclick: () => takeCurrent(acc) }),
            h('button', { class: 'btn primary', text: 'Применить к аккаунту', onclick: () => applyToAccount(acc) })));
      }
      async function takeCurrent(acc) {
        try {
          const r = await api('skin:current', acc.id);
          if (!r) { EWL.toast('У аккаунта стандартный скин — загружать нечего.', 'info'); return; }
          slim = r.variant === 'slim'; drawModel();
          await loadDataUrl(r.dataUrl, `${acc.name}`);
          EWL.toast('Текущий скин загружен в редактор', 'ok');
        } catch (e) { EWL.fail(e); }
      }
      async function applyToAccount(acc) {
        if (!(await EWL.confirm(`Заменить скин аккаунта ${acc.name} тем, что в редакторе? Mojang может ограничивать частоту смены скина.`, 'Применить'))) return;
        try {
          await api('skin:upload', { accountId: acc.id, dataUrl: currentDataUrl(), variant: slim ? 'slim' : 'classic' });
          EWL.toast('Скин загружен. В игре он обновится после перезахода.', 'ok', 6000);
        } catch (e) { EWL.fail(e); }
      }

      // ----- библиотека -----
      const libEl = h('div', { class: 'skin-lib' });
      async function loadLibrary() {
        let list = [];
        try { list = await api('skin:list'); } catch (e) { EWL.fail(e); }
        libEl.replaceChildren();
        if (!list.length) libEl.append(h('div', { class: 'empty', text: 'Пока пусто. Нарисуйте скин и нажмите «В библиотеку».' }));
        for (const s of list) {
          libEl.append(h('div', { class: 'skin-card' },
            h('img', { src: s.dataUrl, alt: s.name, class: 'skin-thumb' }),
            h('div', { class: 'title', text: s.name }),
            h('div', { class: 'row' },
              h('button', { class: 'btn small', text: 'Открыть', onclick: () => loadDataUrl(s.dataUrl, s.name).catch(EWL.fail) }),
              h('button', { class: 'btn small danger', text: 'Удалить', onclick: async () => {
                if (!(await EWL.confirm(`Удалить скин «${s.name}» из библиотеки?`, 'Удалить'))) return;
                try { await api('skin:remove', s.name); loadLibrary(); } catch (e) { EWL.fail(e); }
              } }))));
        }
      }

      // ----- сборка страницы -----
      const onKey = (e) => {
        if (!(e.ctrlKey || e.metaKey) || /input|textarea|select/i.test((e.target && e.target.tagName) || '')) return;
        if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
        else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
      };
      document.addEventListener('keydown', onKey);
      const onData = () => drawMs();
      document.addEventListener('ewl:data', onData);

      root.append(
        h('h1', { text: 'Скины' }),
        h('p', { class: 'sub', text: 'Нарисуйте свой скин прямо в лаунчере: PNG 64×64, как в Minecraft. Рисуйте в синих областях (основной слой) и жёлтых (внешний слой, например шапка или куртка) — включите подписи, чтобы увидеть части тела.' }),
        h('div', { class: 'skin-layout' },
          h('div', { class: 'card' },
            h('div', { class: 'row', style: 'margin-bottom:12px' }, toolBar, brushSel, h('div', { class: 'spacer' }), undoBtn, redoBtn),
            h('div', { class: 'skin-stage' }, view, labels),
            h('div', { class: 'row', style: 'margin-top:10px' }, coord, h('div', { class: 'spacer' }),
              h('label', { class: 'check' }, gridChk, h('span', { text: 'Сетка' })),
              h('label', { class: 'check' }, labelChk, h('span', { text: 'Подписи частей' })))),
          h('div', { class: 'skin-side' },
            h('div', { class: 'card' },
              h('h2', { text: 'Цвет' }),
              h('div', { class: 'row' }, colorInput, hexInput),
              palette, h('div', { class: 'hint', style: 'margin:8px 0 4px', text: 'Недавние:' }), recentEl),
            h('div', { class: 'card' },
              h('h2', { text: 'Как выглядит' }),
              h('div', { class: 'skin-previews' }, previews.map((p) => h('div', { class: 'skin-prev-box' }, p.cv, h('div', { class: 'hint', text: p.label })))),
              h('div', { style: 'margin-top:10px' }, modelSeg)))),
        h('div', { class: 'grid two', style: 'margin-top:16px' },
          h('div', { class: 'card' },
            h('h2', { text: 'Файл' }),
            EWL.field('Название', nameInput),
            h('div', { class: 'row' },
              h('button', { class: 'btn primary', text: 'В библиотеку', onclick: doSave }),
              h('button', { class: 'btn', text: 'Сохранить PNG…', onclick: doExport }),
              h('button', { class: 'btn', text: 'Открыть PNG…', onclick: doImport })),
            h('div', { class: 'row', style: 'margin-top:10px' },
              h('button', { class: 'btn small ghost', text: 'Шаблон (новый скин)', onclick: newSkin }),
              h('button', { class: 'btn small ghost', text: 'Очистить', onclick: clearAll }),
              h('button', { class: 'btn small ghost', text: 'Папка скинов', onclick: () => api('app:openPath', 'skins').catch(EWL.fail) }))),
          msBox),
        h('div', { class: 'card' }, h('h2', { text: 'Моя библиотека' }), libEl),
      );

      drawModel();
      defaultSkin();
      dirty = false;
      redrawAll();
      syncButtons();
      drawMs();
      loadLibrary();

      return () => {
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('ewl:data', onData);
      };
    },
  };
})();
