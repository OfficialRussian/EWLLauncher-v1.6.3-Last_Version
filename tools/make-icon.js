'use strict';
// Генерирует assets/icon.png (256x256) и assets/icon.ico без внешних зависимостей.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 256;
const px = Buffer.alloc(N * N * 4);
const inRound = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), N - 1 - r);
  const cy = Math.min(Math.max(y, r), N - 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// буква «E»: вертикаль + три перекладины
const inE = (x, y) => (x >= 78 && x <= 112 && y >= 64 && y <= 192)
  || (x >= 78 && x <= 182 && y >= 64 && y <= 96)
  || (x >= 78 && x <= 170 && y >= 112 && y <= 144)
  || (x >= 78 && x <= 182 && y >= 160 && y <= 192);

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    if (!inRound(x, y, 56)) { px[i + 3] = 0; continue; }
    const t = (x + y) / (2 * N);
    if (inE(x, y)) { px[i] = 11; px[i + 1] = 26; px[i + 2] = 18; } else {
      px[i] = Math.round(61 + (32 - 61) * t);
      px[i + 1] = Math.round(220 + (184 - 220) * t);
      px[i + 2] = Math.round(132 + (160 - 132) * t);
    }
    px[i + 3] = 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);

const head = Buffer.alloc(22);
head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head[6] = 0; head[7] = 0; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), png);
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([head, png]));
console.log('icon.png / icon.ico созданы');
