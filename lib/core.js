'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const TOML = require('smol-toml');
const YAML = require('yaml');
const registry = require('./registry');

const home = () => os.homedir();
const expand = (p) => (p === '~' ? home() : p.startsWith('~/') ? path.join(home(), p.slice(2)) : p);
const rel = (abs) => path.relative(home(), abs);
const backupRoot = () => process.env.HM_BACKUP_DIR || path.join(home(), 'backups', 'harness-configs');
const cacheFile = () => path.join(process.env.HM_CACHE_DIR || path.join(home(), '.cache', 'harness-manager'), 'latest.json');
const SKIP_DIRS = new Set(['node_modules', '.git']);

const byId = (id) => {
  const h = registry.find((x) => x.id === id);
  if (!h) throw new Error(`Unknown harness: ${id}`);
  return h;
};

// ---------- process helpers ----------
function run(cmd, args, { timeout = 10000, shell = false, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out }); } };
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(-1); }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => finish(-2));
    child.on('close', (c) => finish(c));
  });
}
const userShell = () => (process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash');
const loginShell = (script, opts) => run(userShell(), ['-lc', script], opts);

function extractVersion(s) {
  const m = /(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)/.exec(s || '');
  return m ? m[1] : null;
}
function cmpVersions(a, b) {
  const nums = (v) => v.split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = nums(a), y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---------- detection ----------
const FALLBACK_DIRS = ['~/.local/bin', '~/.opencode/bin', '~/.grok/bin', '~/.local/share/mise/shims', '~/.cargo/bin', '~/go/bin', '/usr/local/bin', '/usr/bin'];
const isExec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

async function resolveBinaries() {
  const names = [...new Set(registry.flatMap((h) => h.bins))];
  const script = names.map((n) => `printf '%s=%s\\n' ${n} "$(command -v ${n} 2>/dev/null)"`).join('; ');
  const { out } = await loginShell(script, { timeout: 15000 });
  const found = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(i + 1).startsWith('/')) found[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  for (const n of names) {
    if (found[n]) continue;
    for (const d of FALLBACK_DIRS) { const p = path.join(expand(d), n); if (isExec(p)) { found[n] = p; break; } }
  }
  return found;
}
// Other copies of the same binary in well-known dirs (e.g. a brew and an npm install side by side).
function alternates(name, primary) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const seen = new Set([real(primary)]);
  const out = [];
  for (const d of FALLBACK_DIRS.filter((x) => !x.includes('mise/shims')).concat(['/home/linuxbrew/.linuxbrew/bin'])) {
    const p = path.join(expand(d), name);
    if (isExec(p) && !seen.has(real(p))) { seen.add(real(p)); out.push(p); }
  }
  return out;
}

async function detectAll() {
  const bins = await resolveBinaries();
  return Promise.all(registry.map(async (h) => {
    let binPath = null;
    for (const b of h.bins) if (bins[b]) { binPath = bins[b]; break; }
    if (!binPath) for (const e of h.extraBins || []) if (isExec(expand(e))) { binPath = expand(e); break; }
    const hasConfig = fs.existsSync(expand(h.configDir));
    let alts = binPath ? alternates(path.basename(binPath), binPath) : [];
    // Our update commands target user-level installs, so prefer a copy under $HOME over a system/brew one.
    const inHome = (p) => p.startsWith(home() + path.sep);
    if (binPath && !inHome(binPath)) {
      const own = alts.find(inHome);
      if (own) { alts = [binPath, ...alts.filter((a) => a !== own)]; binPath = own; }
    }
    const installed = !!binPath || hasConfig;
    let version = null;
    if (binPath) {
      const r = await run(binPath, ['--version'], { timeout: 8000 });
      version = extractVersion(r.out);
    }
    return {
      id: h.id, name: h.name, desc: h.desc, homepage: h.homepage, note: h.note || null,
      installed, binary: !!binPath, binPath, alts, hasConfig, configDir: h.configDir,
      signal: binPath ? 'binary' : hasConfig ? 'config only' : 'not found',
      version, installCmd: h.installCmd, updateCmd: h.updateCmd, canCheck: h.update.type !== 'none',
      items: describeItems(h),
    };
  }));
}

function dirSize(p, limit = 2e9) {
  let total = 0;
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (total > limit) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(f); }
      else if (e.isFile()) { try { total += fs.statSync(f).size; } catch {} }
    }
  };
  walk(p);
  return total;
}
function describeItems(h) {
  return h.items.map((it) => {
    const abs = expand(it.path);
    let exists = false, size = 0;
    try {
      const st = fs.statSync(abs);
      exists = true;
      size = st.isDirectory() ? dirSize(abs) : st.size;
    } catch {}
    return { path: it.path, label: it.label, kind: it.kind, secret: !!it.secret, heavy: !!it.heavy, readonly: !!it.readonly, browse: !!it.browse, exists, size };
  });
}

// ---------- update checks ----------
async function fetchJson(url, timeout = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'harness-manager', accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function githubLatest(repo) {
  // /releases/latest redirects to .../tag/<version>; repos that moved redirect to the new /releases/latest first.
  let url = `https://github.com/${repo}/releases/latest`;
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'harness-manager' } });
    const loc = r.headers.get('location') || '';
    if (loc.includes('/tag/')) {
      const v = extractVersion(loc.split('/tag/')[1]);
      if (v) return v;
      break;
    }
    if (!loc) break;
    url = new URL(loc, url).href;
  }
  throw new Error('no release found');
}
function readCache() { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return {}; } }
function writeCache(c) {
  try { fs.mkdirSync(path.dirname(cacheFile()), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(c)); } catch {}
}

async function latestFor(h, binPath) {
  const u = h.update;
  if (u.type === 'npm') return extractVersion((await fetchJson(`https://registry.npmjs.org/${u.pkg.replace('/', '%2f')}/latest`)).version);
  if (u.type === 'pypi') return extractVersion((await fetchJson(`https://pypi.org/pypi/${u.pkg}/json`)).info.version);
  if (u.type === 'github') return githubLatest(u.repo);
  if (u.type === 'cmd') {
    if (!binPath) throw new Error('not installed');
    const [, ...args] = u.check;
    const r = await run(binPath, args, { timeout: u.timeout || 20000 });
    try { const j = JSON.parse(r.out); const v = extractVersion(String(j.latestVersion || j.latest_version || j.latest || j.version || '')); if (v) return v; } catch {}
    if (/✗|could not|error|timed out|failed/i.test(r.out)) throw new Error(r.out.trim().split('\n').pop().slice(0, 140));
    if (/up to date|already/i.test(r.out)) return 'current';
    const v = extractVersion(r.out.split('\n').filter((l) => /latest|available|new/i.test(l)).join(' '));
    if (v) return v;
    throw new Error(r.code === -1 ? 'check timed out' : 'could not parse check output');
  }
  throw new Error('no update source');
}

async function checkUpdates(detected, { force = false, onResult = () => {} } = {}) {
  const cache = readCache();
  const now = Date.now();
  const results = {};
  await Promise.all(detected.filter((d) => d.installed && d.canCheck).map(async (d) => {
    const h = byId(d.id);
    const c = cache[d.id];
    let latest = null, error = null;
    if (!force && c && now - c.at < 3600e3 && !c.error) latest = c.latest;
    else {
      try { latest = await latestFor(h, d.binPath); } catch (e) { error = String(e.message || e); }
      cache[d.id] = { at: now, latest, error };
    }
    let status = 'unknown';
    if (latest === 'current') status = 'current';
    else if (latest && d.version) status = cmpVersions(d.version, latest) < 0 ? 'update' : 'current';
    else if (latest) status = 'unknown';
    results[d.id] = { latest: latest === 'current' ? d.version : latest, status, error };
    onResult(d.id, results[d.id]);
  }));
  writeCache(cache);
  return results;
}

// ---------- backups ----------
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function listFilesUnder(abs) {
  const out = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(f); }
      else if (e.isFile()) out.push(f);
    }
  };
  walk(abs);
  return out;
}
function collectFiles(h, selectedPaths) {
  const files = new Set();
  for (const it of h.items) {
    if (!selectedPaths.includes(it.path)) continue;
    const abs = expand(it.path);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) listFilesUnder(abs).forEach((f) => files.add(f));
    else if (st.isFile()) files.add(abs);
  }
  return [...files];
}

async function createBackup(id, selectedPaths, { label = 'manual', version = null } = {}) {
  const h = byId(id);
  const files = collectFiles(h, selectedPaths);
  if (!files.length) throw new Error('Nothing to back up — none of the selected paths exist.');
  const includesSecrets = h.items.some((it) => it.secret && selectedPaths.includes(it.path));
  const dirOut = path.join(backupRoot(), id);
  await fsp.mkdir(dirOut, { recursive: true });
  const name = `${stamp()}-${label}.tar.gz`;
  const archive = path.join(dirOut, name);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hm-'));
  try {
    const manifest = {
      harness: id, harnessName: h.name, harnessVersion: version, createdAt: new Date().toISOString(), label,
      includesSecrets, paths: selectedPaths, home: home(),
      files: files.map((f) => ({ path: rel(f), sha256: sha256(f), size: fs.statSync(f).size, mode: fs.statSync(f).mode & 0o777 })),
    };
    await fsp.writeFile(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const list = path.join(tmp, 'files.txt');
    await fsp.writeFile(list, files.map(rel).join('\0'));
    const r = await run('tar', ['-czf', archive, '-C', tmp, 'manifest.json', '-C', home(), '--null', '-T', list], { timeout: 600000 });
    if (r.code !== 0) throw new Error(`tar failed: ${r.out.trim()}`);
    await fsp.chmod(archive, 0o600); // configs can hold MCP keys / proxy tokens, so every archive is private
  } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
  const st = fs.statSync(archive);
  return { archive, name, files: files.length, size: st.size, includesSecrets };
}

async function readManifest(archive) {
  const r = await run('tar', ['-xzOf', archive, 'manifest.json'], { timeout: 30000 });
  if (r.code !== 0) throw new Error('Not a Harness Manager backup (no manifest).');
  return JSON.parse(r.out);
}
async function listBackups(id) {
  const dirIn = path.join(backupRoot(), id);
  let names = [];
  try { names = (await fsp.readdir(dirIn)).filter((n) => n.endsWith('.tar.gz')).sort().reverse(); } catch {}
  const out = [];
  for (const name of names) {
    const archive = path.join(dirIn, name);
    try {
      const m = await readManifest(archive);
      out.push({ name, archive, createdAt: m.createdAt, label: m.label, version: m.harnessVersion, files: m.files.length, includesSecrets: m.includesSecrets, size: fs.statSync(archive).size });
    } catch { out.push({ name, archive, createdAt: null, label: 'unreadable', files: 0, size: 0, broken: true }); }
  }
  return out;
}

const safeRel = (p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');

async function previewRestore(id, archive) {
  const m = await readManifest(archive);
  if (m.harness !== id) throw new Error(`Backup belongs to "${m.harness}", not "${id}".`);
  const changes = [];
  for (const f of m.files) {
    if (!safeRel(f.path)) throw new Error(`Unsafe path in backup: ${f.path}`);
    const abs = path.join(home(), f.path);
    let state;
    if (!fs.existsSync(abs)) state = 'new';
    else state = sha256(abs) === f.sha256 ? 'same' : 'changed';
    changes.push({ path: f.path, state, size: f.size });
  }
  return { manifest: { createdAt: m.createdAt, label: m.label, version: m.harnessVersion, includesSecrets: m.includesSecrets }, changes };
}

async function restoreBackup(id, archive, { onlyChanged = true } = {}) {
  const prev = await previewRestore(id, archive);
  const h = byId(id);
  const m = await readManifest(archive);
  // Pre-restore snapshot of everything the restore will overwrite.
  const overwrite = prev.changes.filter((c) => c.state === 'changed');
  let snapshot = null;
  if (overwrite.length) {
    const paths = h.items.filter((it) => {
      const abs = expand(it.path);
      return overwrite.some((c) => path.join(home(), c.path) === abs || path.join(home(), c.path).startsWith(abs + path.sep));
    }).map((it) => it.path);
    if (paths.length) snapshot = await createBackup(id, paths, { label: 'pre-restore' });
  }
  const todo = prev.changes.filter((c) => (onlyChanged ? c.state !== 'same' : true));
  if (!todo.length) return { restored: 0, snapshot };
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hm-'));
  try {
    const list = path.join(tmp, 'files.txt');
    await fsp.writeFile(list, todo.map((c) => c.path).join('\0'));
    const r = await run('tar', ['-xzf', archive, '-C', home(), '--null', '-T', list, '--no-same-owner'], { timeout: 600000 });
    if (r.code !== 0) throw new Error(`tar failed: ${r.out.trim()}`);
  } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
  return { restored: todo.length, snapshot, version: m.harnessVersion };
}

async function deleteBackup(id, archive) {
  const dirIn = path.join(backupRoot(), id);
  if (path.dirname(archive) !== dirIn || !archive.endsWith('.tar.gz')) throw new Error('Refusing to delete outside the backup folder.');
  await fsp.rm(archive);
}

// ---------- editing ----------
const BROWSE_LIMIT = 200;
function editableFiles(id) {
  const h = byId(id);
  const out = [];
  for (const it of h.items) {
    if (it.secret || it.heavy) continue;
    const abs = expand(it.path);
    let st; try { st = fs.statSync(abs); } catch { out.push({ path: it.path, label: it.label, exists: false, readonly: !!it.readonly, group: 'config' }); continue; }
    if (st.isFile()) out.push({ path: it.path, label: it.label, exists: true, readonly: !!it.readonly, group: 'config' });
    else if (st.isDirectory() && it.browse) {
      for (const f of listFilesUnder(abs).slice(0, BROWSE_LIMIT)) {
        try { if (fs.statSync(f).size > 1e6) continue; } catch { continue; }
        out.push({ path: '~/' + rel(f), label: path.relative(abs, f), exists: true, readonly: !!it.readonly, group: it.label });
      }
    }
  }
  return out;
}
function allowedEditPath(id, p) {
  const f = editableFiles(id).find((x) => x.path === p);
  if (!f) throw new Error('That file is not editable here.');
  return f;
}
function validate(p, text) {
  const ext = path.extname(p).toLowerCase();
  try {
    if (ext === '.json') JSON.parse(text);
    else if (ext === '.toml') TOML.parse(text);
    else if (ext === '.yaml' || ext === '.yml') { const d = YAML.parseDocument(text); if (d.errors.length) throw d.errors[0]; }
  } catch (e) { return String(e.message || e).split('\n')[0]; }
  return null;
}
async function readConfig(id, p) {
  const f = allowedEditPath(id, p);
  const abs = expand(p);
  let text = '';
  try { text = await fsp.readFile(abs, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { text, exists: f.exists, readonly: f.readonly, error: validate(p, text) };
}
async function saveConfig(id, p, text) {
  const f = allowedEditPath(id, p);
  if (f.readonly) throw new Error('This file is managed by the harness and is read-only here.');
  const err = validate(p, text);
  if (err) throw new Error(`Not saved — syntax error: ${err}`);
  const abs = expand(p);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  let mode = 0o644;
  try {
    mode = fs.statSync(abs).mode & 0o777;
    await fsp.copyFile(abs, abs + '.hm.bak');
  } catch {}
  const tmp = `${abs}.hm-${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, { mode });
  await fsp.rename(tmp, abs);
  return { saved: true, backup: fs.existsSync(abs + '.hm.bak') ? abs + '.hm.bak' : null };
}

// ---------- update / install runner ----------
function runStreaming(script, onData) {
  return new Promise((resolve) => {
    const child = spawn(userShell(), ['-lc', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => onData(String(d)));
    child.stderr.on('data', (d) => onData(String(d)));
    child.on('error', (e) => { onData(`\n${e.message}\n`); resolve(-2); });
    child.on('close', (c) => resolve(c));
  });
}
function updateCommand(id) {
  const h = byId(id);
  if (!h.updateCmd) throw new Error('No update command known for this harness.');
  return h.updateCmd.replace(/~\//g, home() + '/');
}

const runCapture = (cmd, args, timeout = 60000) => loginShellExec(cmd, args, timeout);
function loginShellExec(cmd, args, timeout) {
  // args are passed positionally to a login shell so nothing is re-parsed by it.
  return run(userShell(), ['-lc', '"$@"', 'hm', cmd, ...args], { timeout });
}

module.exports = {
  runCapture, registry, expand, backupRoot, detectAll, checkUpdates, createBackup, listBackups, previewRestore, restoreBackup, deleteBackup,
  editableFiles, readConfig, saveConfig, runStreaming, updateCommand, extractVersion, cmpVersions, validate, describeItems, byId,
};
