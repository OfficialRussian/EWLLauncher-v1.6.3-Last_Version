'use strict';
/**
 * Вход через Microsoft (Device Code Flow):
 *  1) код устройства -> пользователь подтверждает на microsoft.com/link
 *  2) токен Microsoft -> Xbox Live (XBL) -> XSTS -> токен Minecraft -> профиль.
 *
 * ВАЖНО: нужен Azure Client ID (Application ID) приложения-«публичного клиента».
 * Как его получить — см. README.md, раздел «Вход через Microsoft».
 */
const http = require('../core/http');

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new AuthError('CANCELLED', 'Вход отменён.'));
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new AuthError('CANCELLED', 'Вход отменён.')); }, { once: true });
  });
}

async function postForm(url, params, signal) {
  const res = await http.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal,
  }, { retries: 1 });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

async function postJson(url, body, signal, headers = {}) {
  const res = await http.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  }, { retries: 1 });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

function oauthError(json) {
  const err = json.error || '';
  const desc = json.error_description || '';
  if (err === 'invalid_client' || /AADSTS(70002|700016|7000218|700025)/.test(desc)) {
    return new AuthError('BAD_CLIENT_ID', 'Неверный Client ID, либо у приложения не включено «Allow public client flows» (Разрешить публичные клиентские потоки).');
  }
  if (err === 'invalid_grant') return new AuthError('REAUTH', 'Сессия Microsoft истекла — войдите в аккаунт заново.');
  return new AuthError('OAUTH', `Ошибка авторизации Microsoft: ${desc.split('\r')[0] || err || 'неизвестная ошибка'}`);
}

async function requestDeviceCode(clientId, signal) {
  if (!clientId) throw new AuthError('NO_CLIENT_ID', 'Не указан Azure Client ID. Откройте «Настройки» и вставьте Client ID (инструкция в README).');
  const { res, json } = await postForm(`${AUTHORITY}/devicecode`, { client_id: clientId, scope: SCOPE }, signal);
  if (!res.ok || !json.device_code) throw oauthError(json);
  return json;
}

async function pollDeviceToken(clientId, dc, signal) {
  const deadline = Date.now() + (dc.expires_in || 900) * 1000;
  let interval = (dc.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await abortableSleep(interval, signal);
    const { json } = await postForm(`${AUTHORITY}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: dc.device_code,
    }, signal);
    if (json.access_token) return json;
    switch (json.error) {
      case 'authorization_pending': continue;
      case 'slow_down': interval += 5000; continue;
      case 'authorization_declined': throw new AuthError('DECLINED', 'Вход отклонён на странице Microsoft.');
      case 'expired_token': throw new AuthError('EXPIRED', 'Код устарел. Начните вход заново.');
      default: throw oauthError(json);
    }
  }
  throw new AuthError('EXPIRED', 'Время ожидания входа истекло. Начните заново.');
}

const XERR = {
  2148916233: 'У этого аккаунта Microsoft нет профиля Xbox. Создайте его на xbox.com и повторите вход.',
  2148916235: 'Xbox Live недоступен в вашей стране/регионе.',
  2148916236: 'Для аккаунта требуется подтверждение возраста (взрослый аккаунт) на xbox.com.',
  2148916237: 'Для аккаунта требуется подтверждение возраста (взрослый аккаунт) на xbox.com.',
  2148916238: 'Детский аккаунт: добавьте его в семью Microsoft и разрешите онлайн-игру.',
};

async function xboxLive(msAccessToken, signal) {
  const { res, json } = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  }, signal);
  if (!res.ok || !json.Token) throw new AuthError('XBL', `Xbox Live отклонил вход (HTTP ${res.status}).`);
  return json.Token;
}

async function xsts(xblToken, signal) {
  const { res, json } = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  }, signal);
  if (!res.ok || !json.Token) {
    throw new AuthError('XSTS', XERR[json.XErr] || `XSTS отклонил вход (HTTP ${res.status}${json.XErr ? `, XErr ${json.XErr}` : ''}).`);
  }
  return { token: json.Token, uhs: json.DisplayClaims.xui[0].uhs };
}

async function minecraftToken({ token, uhs }, signal) {
  const { res, json } = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox',
    { identityToken: `XBL3.0 x=${uhs};${token}` }, signal);
  if (res.status === 403) {
    throw new AuthError('APP_NOT_APPROVED', 'Mojang не одобрил это приложение (Client ID). Новые приложения нужно зарегистрировать через форму https://aka.ms/AppRegInfo — см. README.');
  }
  if (!res.ok || !json.access_token) throw new AuthError('MC', `Сервис Minecraft отклонил вход (HTTP ${res.status}).`);
  return { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in || 86400) * 1000 };
}

async function minecraftProfile(mcToken, signal) {
  const res = await http.request('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mcToken}`, Accept: 'application/json' }, signal,
  }, { retries: 1 });
  if (res.status === 404) throw new AuthError('NO_GAME', 'На этом аккаунте Microsoft нет Minecraft: Java Edition.');
  if (!res.ok) throw new AuthError('PROFILE', `Не удалось получить профиль Minecraft (HTTP ${res.status}).`);
  const j = await res.json();
  return { uuid: j.id, name: j.name };
}

/** Из токена Microsoft получает профиль и токен Minecraft. */
async function completeLogin(msTokens, signal) {
  const xbl = await xboxLive(msTokens.access_token, signal);
  const xs = await xsts(xbl, signal);
  const mc = await minecraftToken(xs, signal);
  const profile = await minecraftProfile(mc.accessToken, signal);
  return {
    name: profile.name,
    uuid: profile.uuid,
    mcToken: mc.accessToken,
    mcExpiresAt: mc.expiresAt,
    refreshToken: msTokens.refresh_token || '',
    xuid: '',
  };
}

async function refreshLogin(clientId, refreshToken, signal) {
  const { res, json } = await postForm(`${AUTHORITY}/token`, {
    grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, scope: SCOPE,
  }, signal);
  if (!res.ok || !json.access_token) throw oauthError(json);
  return completeLogin({ ...json, refresh_token: json.refresh_token || refreshToken }, signal);
}

module.exports = { AuthError, requestDeviceCode, pollDeviceToken, completeLogin, refreshLogin };
