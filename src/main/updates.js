'use strict';
/** Проверка новой версии лаунчера по последнему релизу GitHub. Ничего не скачивает и не устанавливает: только сообщает и даёт ссылку. */
const http = require('./core/http');

/** Сравнение версий вида 1.4.0 / v1.10.2-beta (только числа). Возвращает >0, если a новее b. */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10)).map((x) => (Number.isFinite(x) ? x : 0));
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10)).map((x) => (Number.isFinite(x) ? x : 0));
  for (let i = 0; i < Math.max(3, pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function check({ repo, current }) {
  if (!/^[A-Za-z0-9._-]{1,60}\/[A-Za-z0-9._-]{1,100}$/.test(String(repo || ''))) return { available: false, reason: 'repo' };
  let rel;
  try {
    rel = await http.getJson(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EWLLauncher' } }, { retries: 1 });
  } catch (e) {
    if (e && e.status === 404) return { available: false, reason: 'no-releases' };
    throw e;
  }
  if (!rel || rel.draft || rel.prerelease || !rel.tag_name) return { available: false, reason: 'none' };
  const url = /^https:\/\/github\.com\//.test(rel.html_url || '') ? rel.html_url : `https://github.com/${repo}/releases`;
  return {
    available: compareVersions(rel.tag_name, current) > 0,
    version: String(rel.tag_name).replace(/^v/i, ''),
    url,
    notes: String(rel.body || '').slice(0, 600),
  };
}

module.exports = { check, compareVersions };
