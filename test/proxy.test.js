'use strict';
// Offline recipe tests against a throwaway HOME. Live proof against a real proxy is in test/live/run.js.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-ptest-'));
process.env.HOME = tmp; process.env.SHELL = '/bin/bash'; process.env.PATH = '/usr/bin:/bin';
process.env.HM_BACKUP_DIR = path.join(tmp, 'bk'); process.env.HM_CONFIG_DIR = path.join(tmp, 'hm');
const proxy = require('../lib/proxy');
const jsonc = require('jsonc-parser');
// JSON edits keep content, comments and key order but may re-indent a hand-compacted neighbour, so compare semantically.
const same = (a, b, json) => a === b || (json && JSON.stringify(jsonc.parse(a)) === JSON.stringify(jsonc.parse(b)) && (a.match(/\/\/ .*/g) || []).join() === (b.match(/\/\/ .*/g) || []).join());
const w = (p, t) => { const f = path.join(tmp, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const r = (p) => fs.readFileSync(path.join(tmp, p), 'utf8');
const KEY = 'sk-test-SECRET1234';

(async () => {
  assert.strictEqual(proxy.getSettings().configured, false); // first run: nothing saved, nothing assumed
  assert.strictEqual(proxy.getSettings().url, '');
  assert.throws(() => proxy.preview('codex'), /address first/);
  assert.throws(() => proxy.saveSettings({ url: 'not a host', key: 'x' }), /Enter an address/);
  assert.strictEqual(proxy.skipSetup().configured, true); // "Skip for now" is remembered
  assert.strictEqual(proxy.normUrl('localhost'), 'http://localhost:8317');
  assert.strictEqual(proxy.normUrl('192.168.8.5'), 'http://192.168.8.5:8317');
  assert.strictEqual(proxy.normUrl('https://gw.example.com/v1/'), 'https://gw.example.com');
  proxy.saveSettings({ url: 'http://10.0.0.5:8317/v1/', key: KEY });
  assert.strictEqual(proxy.getSettings().url, 'http://10.0.0.5:8317'); // trailing slash and /v1 normalised
  assert.strictEqual(fs.statSync(path.join(tmp, 'hm/settings.json')).mode & 0o777, 0o600);
  assert(!JSON.stringify(proxy.publicSettings()).includes(KEY)); // renderer never sees the key

  const fixtures = {
    claude: ['.claude/settings.json', '{\n  // keep me\n  "model": "sonnet",\n  "__termsprawlManaged": {"a": 1}\n}\n'],
    codex: ['.codex/config.toml', 'forced_login_method = "chatgpt"\nmodel = "gpt-6.1-sol"\nmodel_provider = "openai"\n\n[desktop]\nx = true\n'],
    opencode: ['.config/opencode/opencode.json', '{\n  "mcp": {}\n}\n'],
    gemini: ['.gemini/settings.json', '{\n  "security": { "auth": { "selectedType": "oauth-personal" } }\n}\n'],
  };
  w('.gemini/.env', 'FOO=bar\n');
  for (const [id, [f, text]] of Object.entries(fixtures)) w(f, text);
  const geminiEnv = r('.gemini/.env');
  const models = ['gpt-6-luna', 'claude-sonnet-5-5'];

  for (const id of ['claude', 'codex', 'opencode', 'gemini']) {
    const f = fixtures[id][0], before = r(f);
    assert.strictEqual(proxy.status(id).connected, false);
    const p = proxy.previewPublic(id, { models, model: 'gpt-6-luna' });
    assert(!JSON.stringify(p).includes(KEY), `${id}: preview leaked the key`);
    assert(JSON.stringify(p).includes('••••1234'), `${id}: preview should show masked key`);
    assert.strictEqual(r(f), before, `${id}: preview must not write`);

    const res = await proxy.connect(id, { models, model: 'gpt-6-luna' });
    assert(res.snapshots.length >= 1, `${id}: pre-connect snapshot`);
    assert(proxy.status(id).connected && !proxy.status(id).stale, `${id}: connected`);
    await proxy.connect(id, { models, model: 'gpt-6-luna' }); // idempotent re-apply keeps ORIGINAL restore values
    const d = await proxy.disconnect(id);
    assert(d.changed, `${id}: disconnect changed something`);
    assert(same(r(f), before, id !== 'codex'), `${id}: disconnect restores original content`);
    assert.strictEqual(proxy.status(id).connected, false);
  }
  assert.strictEqual(r('.gemini/.env'), geminiEnv);

  // editor masking: key never leaves via read, sentinel is swapped back on save
  await proxy.connect('codex');
  const raw = r('.codex/config.toml');
  assert(raw.includes(KEY));
  const shown = proxy.maskInText(raw);
  assert(!shown.includes(KEY) && shown.includes(proxy.SENTINEL));
  assert.strictEqual(proxy.unmaskInText(shown), raw);
  await proxy.disconnect('codex');

  // runCapture passes awkward arguments through the login shell untouched (Hermes flow-mapping)
  const core = require('../lib/core');
  const awkward = `{name: CLIProxyAPI, base_url: "http://h:8317/v1", note: 'it''s', k: $HOME \`x\`}`;
  const rc = await core.runCapture('printf', ['%s|', awkward, 'two words']);
  assert.strictEqual(rc.out, `${awkward}|two words|`);

  // stale detection: proxy URL changed after connecting
  await proxy.connect('claude');
  proxy.saveSettings({ url: 'http://10.0.0.9:8317' });
  assert(proxy.status('claude').stale);
  await proxy.disconnect('claude');

  // foreign keys / comments survive a connect
  await proxy.connect('claude');
  assert(r('.claude/settings.json').includes('// keep me') && r('.claude/settings.json').includes('__termsprawlManaged'));
  await proxy.disconnect('claude');

  // broken JSON is refused, not clobbered
  w('.claude/settings.json', '{ nope');
  assert.throws(() => proxy.preview('claude'), /syntax errors/);

  // opencode without models refuses
  assert.throws(() => proxy.preview('opencode', { models: [] }), /No models/);
  // hermes preview shows two commands, masks key, and does not run anything
  const hp = proxy.previewPublic('hermes', { model: 'gpt-6-luna' });
  assert.strictEqual(hp.commands.length, 2); assert(!hp.commands.join().includes(KEY));
  await assert.rejects(proxy.disconnect('hermes'), /not automated/);
  assert.throws(() => proxy.preview('goose'), /not supported/);

  console.log('proxy tests passed');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
