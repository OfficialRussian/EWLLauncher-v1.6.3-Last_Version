'use strict';
/**
 * Хранилище аккаунтов (accounts.json). Токены шифруются (DPAPI через safeStorage).
 * В интерфейс отдаются только безопасные поля — токены наружу не уходят.
 */
const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('../core/store');
const { userDataDir } = require('../core/paths');
const { protect, unprotect } = require('../core/secrets');
const offline = require('./offline');
const ms = require('./microsoft');

class AccountService {
  constructor(file) {
    this.store = new JsonStore(file || path.join(userDataDir(), 'accounts.json'), { accounts: [], selectedId: '' });
  }

  load() { this.store.load(); return this; }

  _find(id) { return this.store.data.accounts.find((a) => a.id === id); }

  _public(a) {
    return {
      id: a.id, type: a.type, name: a.name, uuid: a.uuid,
      selected: a.id === this.store.data.selectedId,
    };
  }

  list() { return this.store.data.accounts.map((a) => this._public(a)); }

  select(id) {
    if (!this._find(id)) throw new Error('Аккаунт не найден.');
    this.store.data.selectedId = id;
    this.store.save();
  }

  addOffline(name) {
    const n = offline.validateName(name);
    const dup = this.store.data.accounts.find((a) => a.type === 'offline' && a.name.toLowerCase() === n.toLowerCase());
    if (dup) { this.select(dup.id); return this._public(this._find(dup.id)); }
    const acc = { id: crypto.randomUUID(), type: 'offline', name: n, uuid: offline.offlineUuid(n) };
    this.store.data.accounts.push(acc);
    this.store.data.selectedId = acc.id;
    this.store.save();
    return this._public(acc);
  }

  remove(id) {
    const d = this.store.data;
    d.accounts = d.accounts.filter((a) => a.id !== id);
    if (d.selectedId === id) d.selectedId = d.accounts[0] ? d.accounts[0].id : '';
    this.store.save();
  }

  _upsertMicrosoft(r) {
    const d = this.store.data;
    let acc = d.accounts.find((a) => a.type === 'microsoft' && a.uuid === r.uuid);
    if (!acc) {
      acc = { id: crypto.randomUUID(), type: 'microsoft', uuid: r.uuid };
      d.accounts.push(acc);
    }
    acc.name = r.name;
    acc.mcToken = protect(r.mcToken);
    acc.mcExpiresAt = r.mcExpiresAt;
    if (r.refreshToken) acc.refreshToken = protect(r.refreshToken);
    d.selectedId = acc.id;
    this.store.save();
    return acc;
  }

  /** Полный вход через Microsoft. onCode({userCode, verificationUri, expiresIn}) вызывается, когда код готов. */
  async loginMicrosoft(clientId, { onCode, signal }) {
    const dc = await ms.requestDeviceCode(clientId, signal);
    onCode({
      userCode: dc.user_code,
      verificationUri: dc.verification_uri || 'https://www.microsoft.com/link',
      expiresIn: dc.expires_in,
    });
    const tokens = await ms.pollDeviceToken(clientId, dc, signal);
    const result = await ms.completeLogin(tokens, signal);
    return this._public(this._upsertMicrosoft(result));
  }

  /** Данные для запуска; токен Microsoft при необходимости обновляется автоматически. */
  async getLaunchProfile(id, { clientId, signal } = {}) {
    const acc = this._find(id);
    if (!acc) throw new Error('Выберите аккаунт (раздел «Аккаунты»).');
    if (acc.type === 'offline') {
      return { name: acc.name, uuid: acc.uuid, accessToken: '0', userType: 'legacy', xuid: '0', clientId: '0' };
    }
    let token = unprotect(acc.mcToken);
    if (!token || (acc.mcExpiresAt || 0) - Date.now() < 120000) {
      const rt = unprotect(acc.refreshToken);
      if (!rt) throw new ms.AuthError('REAUTH', 'Нужен повторный вход в аккаунт Microsoft.');
      if (!clientId) throw new ms.AuthError('NO_CLIENT_ID', 'Не указан Azure Client ID — он нужен для обновления сессии Microsoft (Настройки).');
      const r = await ms.refreshLogin(clientId, rt, signal);
      this._upsertMicrosoft(r);
      token = r.mcToken;
    }
    return { name: acc.name, uuid: acc.uuid, accessToken: token, userType: 'msa', xuid: '0', clientId: clientId || '0' };
  }
}

module.exports = { AccountService };
