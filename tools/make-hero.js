'use strict';
// Генерирует src/renderer/hero.svg — оригинальный пиксельный пейзаж для фона (не связан с играми).
const fs = require('fs');
const path = require('path');
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const W = 960, H = 360, S = 24; // размер «пикселя»
const layers = [
  { base: 190, amp: 5, color: '#1c2a44', op: 0.85 },
  { base: 235, amp: 4, color: '#162238', op: 0.95 },
  { base: 280, amp: 3, color: '#101a2c', op: 1 },
];
let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" shape-rendering="crispEdges">\n`;
out += `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1020"/><stop offset="1" stop-color="#1d2f52"/></linearGradient></defs>\n<rect width="${W}" height="${H}" fill="url(#sky)"/>\n`;
for (let i = 0; i < 40; i++) out += `<rect x="${Math.floor(rnd() * W / 8) * 8}" y="${Math.floor(rnd() * 150 / 8) * 8}" width="${rnd() > .8 ? 8 : 4}" height="${rnd() > .8 ? 8 : 4}" fill="#cfe3ff" opacity="${(0.25 + rnd() * 0.6).toFixed(2)}"/>\n`;
out += `<rect x="760" y="40" width="48" height="48" fill="#e8f0ff" opacity=".9"/>\n`;
for (const c of [[120, 70, 5], [470, 40, 6], [650, 100, 4]]) { for (let k = 0; k < c[2]; k++) out += `<rect x="${c[0] + k * S}" y="${c[1] + (k % 2 ? -S / 2 : 0)}" width="${S}" height="${S / 2}" fill="#3a4f7a" opacity=".35"/>\n`; }
for (const L of layers) {
  let h = L.base;
  for (let x = 0; x < W; x += S) {
    h += Math.round((rnd() - 0.5) * 4) * (S / 2);
    h = Math.max(L.base - 60, Math.min(L.base + 40, h));
    out += `<rect x="${x}" y="${h}" width="${S}" height="${H - h}" fill="${L.color}" opacity="${L.op}"/>\n`;
    if (rnd() > 0.82) out += `<rect x="${x + 8}" y="${h - 32}" width="8" height="32" fill="${L.color}"/><rect x="${x}" y="${h - 56}" width="24" height="24" fill="${L.color}"/>\n`;
  }
}
out += '</svg>\n';
fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'hero.svg'), out);
console.log('hero.svg создан', out.length, 'байт');
