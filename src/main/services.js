'use strict';
/**
 * Единая точка сборки сервисов (composition root).
 * Все модули создаются здесь; IPC-слой берёт их отсюда. Никаких глобальных синглтонов, кроме logger.
 */
const logger = require('./core/logger');
const { Settings } = require('./settings/settings');
const { AccountService } = require('./accounts/accounts');
const { GameManager } = require('./minecraft/game');
const { ServerManager } = require('./multiplayer/server');
const { HostSession } = require('./multiplayer/session');
const { SkinService } = require('./skins/skins');
const { Stats } = require('./stats/stats');
const { DiscordPresence } = require('./discord');

function createServices() {
  logger.init();
  const settings = new Settings();
  settings.load();
  const accounts = new AccountService().load();
  const game = new GameManager({ settings, accounts });
  const server = new ServerManager({ settings });
  const host = new HostSession();
  const skins = new SkinService();
  const stats = new Stats();
  const presence = new DiscordPresence({ clientId: '1566921266429165568' });

  async function shutdown() {
    try { presence.close(); } catch (_) { /* */ }
    try { await host.stop(); } catch (_) { /* уже остановлено */ }
    try { await Promise.race([server.stop(), new Promise((r) => setTimeout(r, 25000))]); } catch (_) { /* */ }
  }

  return { logger, settings, accounts, game, server, host, skins, stats, presence, shutdown };
}

module.exports = { createServices };
