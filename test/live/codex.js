// Live check: apply the Codex recipe to a COPY of the real config in a temp HOME, then run a real turn through the proxy.
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const real = process.env.HOME;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-live-'));
fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
fs.copyFileSync(path.join(real, '.codex/config.toml'), path.join(tmp, '.codex/config.toml'));
process.env.HOME = tmp; process.env.HM_CONFIG_DIR = path.join(tmp, 'hm'); process.env.HM_BACKUP_DIR = path.join(tmp, 'bk');
const proxy = require('../../lib/proxy');
(async () => {
  proxy.saveSettings({ url: process.env.CPA_URL, key: process.env.CPA_KEY });
  await proxy.connect(process.env.H || 'codex');
  console.log('status:', JSON.stringify(proxy.status(process.env.H || 'codex')));
  const r = spawnSync('codex', ['exec', '--skip-git-repo-check', '-m', process.env.MODEL || 'gpt-6-luna', 'Reply with exactly PROXY-OK'], { env: { ...process.env, CODEX_HOME: path.join(tmp, '.codex'), HOME: tmp }, encoding: 'utf8', timeout: 120000, cwd: tmp });
  const out = (r.stdout + r.stderr).split(process.env.CPA_KEY).join('<key>');
  console.log('exit', r.status); console.log(out.slice(-700));
  await proxy.disconnect(process.env.H || 'codex');
  const same = fs.readFileSync(path.join(tmp, '.codex/config.toml'), 'utf8') === fs.readFileSync(path.join(real, '.codex/config.toml'), 'utf8');
  console.log('disconnect restores original byte-for-byte:', same);
  fs.rmSync(tmp, { recursive: true, force: true });
})();
