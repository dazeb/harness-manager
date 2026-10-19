'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('hm', {
  detect: call('detect'), checkUpdates: call('check-updates'), backup: call('backup'), listBackups: call('list-backups'),
  previewRestore: call('preview-restore'), restore: call('restore'), deleteBackup: call('delete-backup'),
  editableFiles: call('editable-files'), readConfig: call('read-config'), saveConfig: call('save-config'),
  validate: call('validate'), openBackups: call('open-backups'), openExternal: call('open-external'), copy: call('copy'),
  runUpdate: call('run-update'),
  proxySettings: call('proxy-settings'), proxySave: call('proxy-save'), proxySkip: call('proxy-skip'), proxyTest: call('proxy-test'), proxyStatuses: call('proxy-statuses'),
  proxyPreview: call('proxy-preview'), proxyConnect: call('proxy-connect'), proxyDisconnect: call('proxy-disconnect'), proxyCopyKey: call('proxy-copy-key'),
  onUpdateResult: (cb) => ipcRenderer.on('update-result', (_e, m) => cb(m)),
  onRunOutput: (cb) => ipcRenderer.on('run-output', (_e, m) => cb(m)),
});
