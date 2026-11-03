'use strict';
/** Сторона друга: разбор приглашения и проверка доступности сервера по каждому адресу. */
const invite = require('./invite');
const { probe, describeProbeError } = require('./probe');
const { isPublicAddress } = require('./netinfo');

async function inspectInvite(code, { allowLocal = false } = {}) {
  const inv = invite.decode(code);
  if (inv.expired) {
    throw new invite.InviteError('EXPIRED', 'Срок действия приглашения истёк. Попросите друга создать новое.');
  }
  let addrs = inv.addrs;
  if (!allowLocal) {
    addrs = addrs.filter((a) => isPublicAddress(a.host));
    if (!addrs.length) {
      throw new invite.InviteError('LOCAL_ONLY',
        'В приглашении только локальные адреса (LAN). Включите «Разрешить локальные адреса», если вы в одной сети с хозяином.');
    }
  }
  const results = await Promise.all(addrs.map(async (a) => {
    try {
      const r = await probe(a.host, a.port, { timeoutMs: 5000 });
      return { ...r, address: invite.formatAddress(a) };
    } catch (e) {
      return { ok: false, host: a.host, port: a.port, address: invite.formatAddress(a), error: describeProbeError(e) };
    }
  }));
  const best = results.filter((r) => r.ok).sort((a, b) => a.latencyMs - b.latencyMs)[0] || null;
  return {
    invite: { name: inv.name, version: inv.version, expiresAt: inv.expiresAt },
    results,
    best,
  };
}

module.exports = { inspectInvite };
