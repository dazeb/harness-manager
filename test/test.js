'use strict';
// Runs against a throwaway HOME — never touches real dotfiles.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-test-'));
process.env.HOME = tmp;
process.env.SHELL = '/bin/bash';
process.env.PATH = '/usr/bin:/bin';
process.env.HM_BACKUP_DIR = path.join(tmp, 'bk');
process.env.HM_CACHE_DIR = path.join(tmp, 'cache');
const core = require('../lib/core');

const w = (p, t) => { const f = path.join(tmp, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const r = (p) => fs.readFileSync(path.join(tmp, p), 'utf8');

(async () => {
  w('.codex/config.toml', 'model = "a"\n');
  w('.codex/auth.json', '{"token":"SECRET"}');
  w('.codex/rules/r1.rules', 'rule');
  w('.codex/sessions/big.jsonl', 'x'.repeat(1000));
  w('.local/bin/fakeagent', '#!/bin/sh\necho "fakeagent 1.2.3"\n'); fs.chmodSync(path.join(tmp, '.local/bin/fakeagent'), 0o755);

  // version helpers
  assert.strictEqual(core.extractVersion('claude 2.1.302 (Claude Code)'), '2.1.302');
  assert.strictEqual(core.extractVersion('Hermes Agent v0.22.1+83.gdb44 (2026.9.24)'), '0.22.1+83.gdb44');
  assert(core.cmpVersions('0.9.0', '0.10.0') < 0 && core.cmpVersions('2.0.0', '1.9.9') > 0 && core.cmpVersions('1.0.0', '1.0.0') === 0);

  // detection: config-only signal, not installed otherwise
  const det = await core.detectAll();
  const codex = det.find((d) => d.id === 'codex');
  assert(codex.installed && !codex.binary && codex.signal === 'config only');
  assert(!det.find((d) => d.id === 'qwen').installed);
  assert.strictEqual(codex.items.find((i) => i.path === '~/.codex/auth.json').secret, true);

  // backup excludes secrets by default selection; sessions never captured
  const sel = ['~/.codex/config.toml', '~/.codex/rules'];
  const b1 = await core.createBackup('codex', sel, { label: 'manual' });
  assert.strictEqual(b1.files, 2); assert(!b1.includesSecrets);
  const list = await core.listBackups('codex');
  assert.strictEqual(list.length, 1);

  // secrets opt-in -> archive is 0600
  const b2 = await core.createBackup('codex', [...sel, '~/.codex/auth.json'], { label: 'withsecrets' });
  assert(b2.includesSecrets && (fs.statSync(b2.archive).mode & 0o777) === 0o600);
  assert.strictEqual(fs.statSync(b1.archive).mode & 0o777, 0o600);

  // edit: validation, .bak, atomic write, secret/readonly refused
  assert.deepStrictEqual((await core.readConfig('codex', '~/.codex/config.toml')).error, null);
  await assert.rejects(core.saveConfig('codex', '~/.codex/config.toml', 'model = = broken'), /syntax error/);
  assert.strictEqual(r('.codex/config.toml'), 'model = "a"\n');
  await core.saveConfig('codex', '~/.codex/config.toml', 'model = "b"\n');
  assert.strictEqual(r('.codex/config.toml'), 'model = "b"\n');
  assert.strictEqual(r('.codex/config.toml.hm.bak'), 'model = "a"\n');
  await assert.rejects(core.readConfig('codex', '~/.codex/auth.json'), /not editable/);
  await assert.rejects(core.readConfig('codex', '~/../../etc/passwd'), /not editable/);
  w('.hermes/config.yaml', 'a: 1\n');
  await assert.rejects(core.saveConfig('hermes', '~/.hermes/config.yaml', 'a: 2\n'), /read-only/);

  // restore: preview, auto pre-restore snapshot, overwrite, new file recreated
  fs.rmSync(path.join(tmp, '.codex/rules'), { recursive: true });
  const pv = await core.previewRestore('codex', b1.archive);
  assert.deepStrictEqual(pv.changes.map((c) => c.state).sort(), ['changed', 'new']);
  const res = await core.restoreBackup('codex', b1.archive);
  assert.strictEqual(res.restored, 2);
  assert(res.snapshot && res.snapshot.name.includes('pre-restore'));
  assert.strictEqual(r('.codex/config.toml'), 'model = "a"\n');
  assert.strictEqual(r('.codex/rules/r1.rules'), 'rule');
  assert.strictEqual(r('.codex/auth.json'), '{"token":"SECRET"}'); // untouched
  assert.strictEqual((await core.restoreBackup('codex', b1.archive)).restored, 0); // idempotent

  // restore rejects another harness's archive and traversal
  await assert.rejects(core.previewRestore('claude', b1.archive), /belongs to/);
  await assert.rejects(core.deleteBackup('codex', '/etc/passwd'), /Refusing/);

  // streaming runner
  let out = ''; const code = await core.runStreaming('echo hi', (d) => (out += d));
  assert.strictEqual(code, 0); assert.match(out, /hi/);

  console.log('all tests passed');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
