// Live check per harness: apply the recipe to a COPY of the real config in a temp HOME, run one real turn through the proxy,
// then disconnect and confirm the original is restored. Usage: CPA_URL=… CPA_KEY=… node test/live/run.js <claude|codex|gemini|opencode> [model]
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const id = process.argv[2], model = process.argv[3];
const real = process.env.HOME;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-live-'));
process.env.HOME = tmp; process.env.HM_CONFIG_DIR = path.join(tmp, 'hm'); process.env.HM_BACKUP_DIR = path.join(tmp, 'bk');
const proxy = require('../../lib/proxy');
const rc = proxy.recipes[id];
const files = rc.parts ? rc.parts().map((p) => p.file) : [rc.file()];
const orig = {};
for (const f of files) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const rf = f.replace(tmp, real);
  if (process.env.MINIMAL && f.endsWith('settings.json')) fs.writeFileSync(f, JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
  else if (fs.existsSync(rf)) fs.copyFileSync(rf, f);
  orig[f] = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
const turn = 'Reply with exactly PROXY-OK';
const CMD = {
  codex: () => ['codex', ['exec', '--skip-git-repo-check', '-m', model || 'gpt-6-luna', turn], { CODEX_HOME: path.join(tmp, '.codex') }],
  claude: () => ['claude', ['-p', turn, ...(model ? [] : [])], { CLAUDE_CONFIG_DIR: path.join(tmp, '.claude') }],
  gemini: () => ['gemini', ['-p', turn], { GEMINI_CLI_HOME: tmp, ...(process.env.TRUST ? { GEMINI_CLI_TRUST_WORKSPACE: 'true' } : {}) }],
  opencode: () => ['opencode', ['run', '-m', `cliproxyapi/${model || 'gpt-6-luna'}`, turn], { XDG_CONFIG_HOME: path.join(tmp, '.config') }],
}[id]();
(async () => {
  if (id === 'gemini' && process.env.TRUSTFILE) fs.writeFileSync(path.join(tmp, '.gemini/trustedFolders.json'), JSON.stringify({ [tmp]: 'TRUST_FOLDER' }));
  proxy.saveSettings({ url: process.env.CPA_URL, key: process.env.CPA_KEY });
  const models = id === 'opencode' || process.env.WITH_MODELS ? (await proxy.listModels(process.env.CPA_URL, process.env.CPA_KEY)).map((m) => m.id) : [];
  await proxy.connect(id, { model: id === 'claude' || id === 'gemini' ? model : undefined, fastModel: id === 'claude' ? model : undefined, models });
  console.log('status:', JSON.stringify(proxy.status(id)));
  const r = spawnSync(CMD[0], CMD[1], { env: { ...process.env, HOME: tmp, ...CMD[2] }, encoding: 'utf8', timeout: 150000, cwd: tmp });
  const out = (r.stdout + '\n' + r.stderr).split(process.env.CPA_KEY).join('<key>');
  console.log('exit', r.status); console.log(out.split('\n').filter((l) => !/rmcp|mcp/i.test(l)).join('\n').slice(-600));
  await proxy.disconnect(id);
  const ok = files.every((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null) === orig[f] || (orig[f] === null && fs.existsSync(f) && ['', '{}'].includes(fs.readFileSync(f, 'utf8').trim())));
  console.log('disconnect restores original:', ok);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e.message); process.exit(1); });
