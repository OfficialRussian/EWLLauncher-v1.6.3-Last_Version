'use strict';
/** Вспомогательные функции по IP-адресам: приватные/CGNAT диапазоны, глобальный IPv6. */
const os = require('os');
const net = require('net');

function parseV4(ip) {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').map(Number);
}

/** Адрес, который не маршрутизируется из интернета (LAN, loopback, link-local, CGNAT, multicast). */
function isNonPublicV4(ip) {
  const p = parseV4(ip);
  if (!p) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

/** 100.64.0.0/10 — «серый» адрес провайдера (CGNAT): прямое подключение извне невозможно. */
function isCgnatV4(ip) {
  const p = parseV4(ip);
  return !!p && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

function isGlobalV6(addr) {
  if (!net.isIPv6(addr)) return false;
  const a = addr.toLowerCase();
  if (a === '::1' || a === '::') return false;
  if (/^fe[89ab]/.test(a)) return false; // link-local
  if (/^f[cd]/.test(a)) return false; // ULA
  return /^[23]/.test(a); // глобальный unicast 2000::/3
}

function isPublicAddress(host) {
  if (net.isIPv4(host)) return !isNonPublicV4(host);
  if (net.isIPv6(host)) return isGlobalV6(host);
  return false;
}

function globalIPv6() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      const fam = typeof i.family === 'string' ? i.family : `IPv${i.family}`;
      if (fam === 'IPv6' && !i.internal && isGlobalV6(i.address)) out.push(i.address);
    }
  }
  return out;
}

module.exports = { isNonPublicV4, isCgnatV4, isGlobalV6, isPublicAddress, globalIPv6 };
