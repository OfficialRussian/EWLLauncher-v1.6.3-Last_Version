'use strict';
/** Точка входа Electron: окно, безопасность, единственный экземпляр, корректное завершение. */
const path = require('path');
const { app, BrowserWindow, Menu, shell } = require('electron');
const { createServices } = require('./services');
const { register } = require('./ipc/register');

const DEV = process.argv.includes('--dev');
let win = null;
let services = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    services = createServices();
    register(services, () => win);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (e) => {
    if (quitting || !services) return;
    e.preventDefault();
    quitting = true;
    services.shutdown().finally(() => app.quit());
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0e1016',
    title: 'EWLLauncher',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: DEV,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // Никаких переходов и новых окон внутри лаунчера: внешние ссылки открываются только через app:openExternal.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  void shell;
}
