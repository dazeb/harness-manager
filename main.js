'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron');
const path = require('path');
const core = require('./lib/core');
const proxy = require('./lib/proxy');

let win;
let state = { harnesses: [] };

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 560, backgroundColor: '#14161a', title: 'Harness Manager',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

// Every handler returns { ok, data } | { ok:false, error } so the renderer never sees a raw rejection.
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

handle('detect', async () => { state.harnesses = await core.detectAll(); return state.harnesses; });
handle('check-updates', async (force) => {
  if (!state.harnesses.length) state.harnesses = await core.detectAll();
  return core.checkUpdates(state.harnesses, { force, onResult: (id, r) => win.webContents.send('update-result', { id, r }) });
});
handle('backup', async (id, paths) => {
  const h = state.harnesses.find((x) => x.id === id);
  return core.createBackup(id, paths, { label: 'manual', version: h && h.version });
});
handle('list-backups', (id) => core.listBackups(id));
handle('preview-restore', (id, archive) => core.previewRestore(id, archive));
handle('restore', (id, archive) => core.restoreBackup(id, archive));
handle('delete-backup', (id, archive) => core.deleteBackup(id, archive));
handle('editable-files', (id) => core.editableFiles(id));
handle('read-config', async (id, p) => { const r = await core.readConfig(id, p); return { ...r, text: proxy.maskInText(r.text) }; });
handle('save-config', (id, p, text) => core.saveConfig(id, p, proxy.unmaskInText(text)));
handle('validate', (p, text) => core.validate(p, text));
handle('open-backups', async () => { require('fs').mkdirSync(core.backupRoot(), { recursive: true }); const r = await shell.openPath(core.backupRoot()); if (r) throw new Error(r); return true; });
handle('open-external', (url) => { if (!/^https:\/\//.test(url)) throw new Error('Only https links'); return shell.openExternal(url); });
handle('proxy-settings', () => proxy.publicSettings());
handle('proxy-skip', () => proxy.skipSetup());
handle('proxy-save', (s) => { proxy.saveSettings(s); return proxy.publicSettings(); });
handle('proxy-test', async (url, key) => { const t = await proxy.testConnection(url, key); return { count: t.count, owners: t.owners, models: t.models.filter((m) => proxy.isChatModel(m.id)) }; });
handle('proxy-statuses', () => proxy.allStatuses());
handle('proxy-preview', (id, opts) => proxy.previewPublic(id, opts));
handle('proxy-connect', (id, opts) => proxy.connect(id, opts));
handle('proxy-disconnect', (id) => proxy.disconnect(id));
handle('proxy-copy-key', () => proxy.copyKeyTo(clipboard));
handle('copy', (text) => { clipboard.writeText(String(text)); return true; });

handle('run-update', async (id) => {
  const h = state.harnesses.find((x) => x.id === id);
  const cmd = core.updateCommand(id);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Run update', 'Cancel'], defaultId: 1, cancelId: 1, title: `Update ${h ? h.name : id}`,
    message: `Run this command to update ${h ? h.name : id}?`, detail: cmd,
  });
  if (response !== 0) return { cancelled: true };
  const code = await core.runStreaming(cmd, (chunk) => win.webContents.send('run-output', { id, chunk }));
  return { cancelled: false, code, cmd };
});

app.whenReady().then(() => {
  createWindow();
  // Test hooks: HM_SCREENSHOT=/path.png renders the window once, saves it and exits; HM_EVAL runs JS first.
  if (process.env.HM_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.HM_EVAL) { await win.webContents.executeJavaScript('(async () => {' + process.env.HM_EVAL + '})()'); await new Promise((r) => setTimeout(r, 1500)); }
      const img = await win.webContents.capturePage();
      require('fs').writeFileSync(process.env.HM_SCREENSHOT, img.toPNG());
      app.quit();
    }, Number(process.env.HM_SHOT_DELAY || 25000)));
  }
});
app.on('window-all-closed', () => app.quit());
