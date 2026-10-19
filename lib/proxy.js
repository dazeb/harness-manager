'use strict';
// "Connect to CLIProxyAPI": per-harness recipes that point a harness's config at a CLIProxyAPI gateway.
// A recipe is a pure text transform: (currentText, {url, key, models}) -> {text, prev}; undo(text, prev) -> text.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const jsonc = require('jsonc-parser');
const core = require('./core');

const home = () => os.homedir();
const cfgDir = () => process.env.HM_CONFIG_DIR || path.join(home(), '.config', 'harness-manager');
const settingsFile = () => path.join(cfgDir(), 'settings.json');
const stateFile = () => path.join(cfgDir(), 'state.json');

const mask = (k) => (k && k.length > 4 ? `••••${k.slice(-4)}` : k ? '••••' : '');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function writeJson600(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// ---------- proxy settings + connection test ----------
// Accepts "host", "host:port", "http://host", "http://host:8317/v1/" … and returns "http://host:8317".
const DEFAULT_PORT = 8317;
function normUrl(u) {
  const v = String(u || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const m = /^(?:(https?):\/\/)?(\[[^\]]+\]|[^\s/:@]+)(?::(\d{1,5}))?(?:\/.*)?$/i.exec(v);
  if (!m) return '';
  const scheme = (m[1] || 'http').toLowerCase();
  const port = m[3] || (scheme === 'http' ? String(DEFAULT_PORT) : '');
  return `${scheme}://${m[2]}${port ? `:${port}` : ''}`;
}
function getSettings() {
  const s = readJson(settingsFile(), {});
  const url = normUrl(s.url);
  return { url, key: s.key || '', hasKey: !!s.key, keyMasked: mask(s.key), configured: !!url || !!s.skipped };
}
function saveSettings({ url, key }) {
  const cur = readJson(settingsFile(), {});
  const nu = normUrl(url);
  if (!nu) throw new Error('Enter an address like 192.168.1.50 or http://192.168.1.50:8317 (or localhost).');
  writeJson600(settingsFile(), { url: nu, key: key === undefined || key === '' ? cur.key || '' : String(key).trim() });
  return getSettings();
}
// "Skip for now" on first run: remembered so the question isn't asked on every launch.
function skipSetup() { const cur = readJson(settingsFile(), {}); writeJson600(settingsFile(), { ...cur, skipped: true }); return getSettings(); }
async function listModels(url, key) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${normUrl(url)}/v1/models`, { signal: ctl.signal, headers: { authorization: `Bearer ${key}` } });
    if (r.status === 401) throw new Error(key ? 'Reachable, but the API key was rejected (401)' : 'Reachable, but it needs an API key — enter it above');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.data || []).map((m) => ({ id: m.id, owner: m.owned_by }));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timed out — is the proxy running and reachable?');
    if (e.cause && e.cause.code) throw new Error(`Cannot reach ${normUrl(url)} (${e.cause.code})`);
    throw e;
  } finally { clearTimeout(t); }
}
async function testConnection(url, key) {
  const k = key || getSettings().key;
  const models = await listModels(url || getSettings().url, k);
  const owners = {};
  for (const m of models) owners[m.owner] = (owners[m.owner] || 0) + 1;
  return { count: models.length, owners, models };
}

// ---------- text helpers ----------
const MARK_A = '# >>> harness-manager: cliproxyapi >>>';
const MARK_B = '# <<< harness-manager: cliproxyapi <<<';
const tq = (s) => JSON.stringify(String(s)); // JSON strings are valid TOML basic strings

function stripBlock(text) {
  const a = text.indexOf(MARK_A);
  if (a < 0) return text;
  const b = text.indexOf(MARK_B, a);
  if (b < 0) return text;
  return (text.slice(0, a).replace(/\n+$/, '\n') + text.slice(b + MARK_B.length).replace(/^\n+/, '')).replace(/^\n+/, '');
}
// Top-level region of a TOML file = everything before the first [table] header.
function topLevelEnd(text) { const m = /^\s*\[/m.exec(text); return m ? m.index : text.length; }


// ---------- JSON(C) helpers: edit in place so comments, key order and foreign keys survive ----------
const JFMT = { insertSpaces: true, tabSize: 2, eol: '\n', keepLines: true };
function jget(text, pth) {
  try { const n = jsonc.findNodeAtLocation(jsonc.parseTree(text) || { type: 'object', children: [] }, pth); return n ? jsonc.getNodeValue(n) : undefined; } catch { return undefined; }
}
function jset(text, pth, value) {
  const base = text.trim() ? text : '{}\n';
  return jsonc.applyEdits(base, jsonc.modify(base, pth, value, { formattingOptions: JFMT }));
}
function jparseOk(text) { const errs = []; jsonc.parse(text, errs, { allowTrailingComma: true }); return errs.length === 0; }
function envRecipe(label, fileRel, keys, notes) {
  // keys: map of logical name -> env var, 'base'/'key' required; sets settings.json "env" entries.
  return {
    label, notes, file: () => path.join(home(), fileRel),
    detect(text) { const u = jget(text, ['env', keys.base]); return { connected: !!u && !!jget(text, ['env', keys.key]), url: u || null }; },
    plan(text, { url, key, model, fastModel }) {
      if (text.trim() && !jparseOk(text)) throw new Error('File has syntax errors — fix it in the editor first.');
      const prev = { __hadEnv: jget(text, ['env']) !== undefined };
      const want = { [keys.base]: url, [keys.key]: key };
      if (model) want[keys.model] = model;
      if (fastModel && keys.fast) want[keys.fast] = fastModel;
      let t = text;
      for (const [k, v] of Object.entries(want)) { prev[k] = jget(t, ['env', k]) ?? null; t = jset(t, ['env', k], v); }
      return { text: t, prev };
    },
    undo(text, prev) {
      let t = text;
      for (const k of Object.values(keys)) {
        if (jget(t, ['env', k]) === undefined) continue;
        const old = prev && prev[k];
        t = jset(t, ['env', k], old == null ? undefined : old);
      }
      // drop an env object we emptied
      const env = jget(t, ['env']);
      if (env && typeof env === 'object' && !Object.keys(env).length && !(prev && prev.__hadEnv)) t = jset(t, ['env'], undefined);
      return t;
    },
  };
}


// ---------- .env helpers ----------
function dotenvGet(text, k) { const m = new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=\\s*(.*)$`, 'm').exec(text); return m ? m[1].trim().replace(/^(["'])(.*)\1$/, '$2') : undefined; }
function dotenvSet(text, k, v) {
  const re = new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=.*\\n?`, 'm');
  if (v == null) return text.replace(re, '');
  const line = `${k}=${v}\n`;
  if (re.test(text)) return text.replace(re, line);
  return (text && !text.endsWith('\n') ? text + '\n' : text) + line;
}

// ---------- recipes ----------
const recipes = {
  claude: envRecipe('Claude Code', '.claude/settings.json',
    { base: 'ANTHROPIC_BASE_URL', key: 'ANTHROPIC_AUTH_TOKEN', model: 'ANTHROPIC_MODEL', fast: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
    'Sets ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in the env block of settings.json. Claude Code then talks to the proxy\'s Anthropic endpoint.'),

  gemini: {
    label: 'Gemini CLI',
    notes: 'Writes GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL to ~/.gemini/.env, selects "Gemini API key" auth and sets the default model in settings.json (replacing Google login while connected). Gemini only reads ~/.gemini/.env in folders it trusts; elsewhere it will report a missing API key.',
    detect(text) { const u = dotenvGet(text, 'GOOGLE_GEMINI_BASE_URL'); return { connected: !!u && !!dotenvGet(text, 'GEMINI_API_KEY'), url: u || null }; },
    parts: () => [
      { key: 'env', file: path.join(home(), '.gemini', '.env'),
        plan(text, { url, key }) {
          const prev = { GEMINI_API_KEY: dotenvGet(text, 'GEMINI_API_KEY') ?? null, GOOGLE_GEMINI_BASE_URL: dotenvGet(text, 'GOOGLE_GEMINI_BASE_URL') ?? null };
          return { text: dotenvSet(dotenvSet(text, 'GEMINI_API_KEY', key), 'GOOGLE_GEMINI_BASE_URL', url), prev };
        },
        undo(text, prev) { return dotenvSet(dotenvSet(text, 'GEMINI_API_KEY', prev.GEMINI_API_KEY ?? null), 'GOOGLE_GEMINI_BASE_URL', prev.GOOGLE_GEMINI_BASE_URL ?? null); } },
      { key: 'settings', file: path.join(home(), '.gemini', 'settings.json'),
        plan(text, { model }) {
          if (text.trim() && !jparseOk(text)) throw new Error('settings.json has syntax errors — fix it in the editor first.');
          const prev = { selectedType: jget(text, ['security', 'auth', 'selectedType']) ?? null, modelName: jget(text, ['model', 'name']) ?? null, hadModel: jget(text, ['model']) !== undefined };
          let t = jset(text, ['security', 'auth', 'selectedType'], 'gemini-api-key');
          if (model) t = jset(t, ['model', 'name'], model);
          return { text: t, prev };
        },
        undo(text, prev) {
          let t = text;
          if (jget(t, ['security', 'auth', 'selectedType']) === 'gemini-api-key') t = jset(t, ['security', 'auth', 'selectedType'], prev.selectedType ?? undefined);
          if (jget(t, ['model', 'name']) !== undefined && prev.modelName !== jget(t, ['model', 'name'])) {
            t = jset(t, ['model', 'name'], prev.modelName ?? undefined);
            const m = jget(t, ['model']);
            if (m && typeof m === 'object' && !Object.keys(m).length && !prev.hadModel) t = jset(t, ['model'], undefined);
          }
          return t;
        } },
    ],
  },
  opencode: {
    label: 'OpenCode', needsModels: true,
    notes: 'Adds a "cliproxyapi" provider (OpenAI-compatible) to opencode.json with the proxy\'s models. Pick them with /models or `-m cliproxyapi/<model>`.',
    file: () => path.join(home(), '.config', 'opencode', 'opencode.json'),
    detect(text) { const u = jget(text, ['provider', 'cliproxyapi', 'options', 'baseURL']); return { connected: !!u, url: u ? u.replace(/\/v1$/, '') : null }; },
    plan(text, { url, key, models }) {
      if (text.trim() && !jparseOk(text)) throw new Error('opencode.json has syntax errors — fix it in the editor first.');
      if (!models || !models.length) throw new Error('No models to register — test the connection first.');
      const prev = { provider: jget(text, ['provider', 'cliproxyapi']) ?? null };
      const entry = { npm: '@ai-sdk/openai-compatible', name: 'CLIProxyAPI', options: { baseURL: `${url}/v1`, apiKey: key }, models: Object.fromEntries(models.map((m) => [m, { name: m }])) };
      return { text: jset(text, ['provider', 'cliproxyapi'], entry), prev };
    },
    undo(text, prev) {
      let t = jset(text, ['provider', 'cliproxyapi'], prev && prev.provider ? prev.provider : undefined);
      const p = jget(t, ['provider']);
      if (p && typeof p === 'object' && !Object.keys(p).length) t = jset(t, ['provider'], undefined);
      return t;
    },
  },
  hermes: {
    label: 'Hermes Agent', needsModels: false, command: true,
    notes: 'Hermes manages its own config, so this runs two `hermes config set` commands (provider + key). Disconnect is not automated — remove `providers.cliproxyapi` with Hermes.',
    file: () => path.join(home(), '.hermes', 'config.yaml'),
    detect(text) { const m = /^\s{2}cliproxyapi:\s*\n(?:\s{4}.*\n)*?\s{4}base_url:\s*(\S+)/m.exec(text); return { connected: !!m, url: m ? m[1].replace(/\/v1$/, '') : null }; },
    commands({ url, key, model }) {
      const host = url.replace(/^https?:\/\//, '').replace(/[.:]/g, '_').replace(/\W/g, '_');
      const env = `HERMES_CUSTOM_${host.toUpperCase()}_API_KEY`;
      const flow = `{name: CLIProxyAPI, base_url: "${url}/v1", key_env: ${env}, model: ${model || 'gpt-6-luna'}, discover_models: true, context_length: 400000}`;
      return [['hermes', ['config', 'set', 'providers.cliproxyapi', flow]], ['hermes', ['config', 'set', env, key]]];
    },
  },
  codex: {
    label: 'Codex CLI',
    file: () => path.join(home(), '.codex', 'config.toml'),
    notes: 'Adds a `cliproxyapi` model provider and makes it the default. Codex then uses the proxy\'s OpenAI models.',
    detect(text) {
      const m = /^base_url\s*=\s*"([^"]+)"/m.exec(text.slice(text.indexOf(MARK_A) >= 0 ? text.indexOf(MARK_A) : 0));
      if (text.indexOf(MARK_A) < 0) return { connected: false };
      return { connected: /^\s*model_provider\s*=\s*"cliproxyapi"/m.test(text.slice(0, topLevelEnd(text))), url: m && m[1].replace(/\/v1$/, '') };
    },
    plan(text, { url, key }) {
      let t = stripBlock(text);
      const end = topLevelEnd(t);
      let top = t.slice(0, end), rest = t.slice(end);
      const re = /^model_provider\s*=\s*"([^"]*)"[^\n]*\n?/m;
      const prevMatch = re.exec(top);
      const prev = { model_provider: prevMatch ? prevMatch[1] : null, tail: /\n*$/.exec(stripBlock(text))[0] };
      top = prevMatch ? top.replace(re, 'model_provider = "cliproxyapi"\n') : (top.trim() ? top.replace(/\n*$/, '\n') : '') + 'model_provider = "cliproxyapi"\n' + (rest ? '\n' : '');
      const block = `${MARK_A}\n[model_providers.cliproxyapi]\nname = "CLIProxyAPI"\nbase_url = ${tq(url + '/v1')}\nwire_api = "responses"\nexperimental_bearer_token = ${tq(key)}\n${MARK_B}\n`;
      t = top + rest;
      return { text: t.replace(/\n*$/, '\n\n') + block, prev };
    },
    undo(text, prev) {
      let t = stripBlock(text).replace(/\n+$/, '') + ((prev && prev.tail) || '\n');
      const end = topLevelEnd(t);
      let top = t.slice(0, end), rest = t.slice(end);
      const re = /^model_provider\s*=\s*"cliproxyapi"[^\n]*\n?/m;
      if (prev && prev.model_provider) top = top.replace(re, `model_provider = "${prev.model_provider}"\n`);
      else top = top.replace(re, '');
      return top + rest;
    },
  },
};

// ---------- orchestration ----------
// A recipe is either single-file ({file, plan, undo, detect}) or multi-file ({parts:[{key,file,plan,undo}], detect}).
const partsOf = (r) => (r.parts ? r.parts() : r.command ? [] : [{ key: 'main', file: r.file(), plan: r.plan, undo: r.undo }]);
function recipeFor(id) { const r = recipes[id]; if (!r) throw new Error('Connecting is not supported for this harness yet.'); return r; }
const supported = () => Object.keys(recipes);
const mainFile = (r) => (r.parts ? r.parts()[0].file : r.file());

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
const redact = (s, key) => (key ? s.split(key).join(mask(key)) : s);
const lines = (s) => s.split('\n');

function status(id) {
  const r = recipes[id];
  if (!r) return { supported: false };
  const d = r.detect(readText(mainFile(r)));
  const s = getSettings();
  return { supported: true, connected: !!d.connected, url: d.url || null, stale: !!d.connected && !!d.url && normUrl(d.url) !== s.url, label: r.label, notes: r.notes, needsModels: !!r.needsModels, modelPick: r.modelPick || null };
}

function preview(id, opts = {}) {
  const r = recipeFor(id);
  const s = getSettings();
  const url = normUrl(opts.url) || s.url, key = opts.key || s.key;
  if (!url) throw new Error('Set the CLIProxyAPI address first (CLIProxyAPI button in the header).');
  if (!key) throw new Error('Set the CLIProxyAPI key first (CLIProxyAPI button in the header).');
  if (r.command) {
    const cmds = r.commands({ url, key, model: opts.model }).map(([c, a]) => `${c} ${a.map((x) => (/[\s{}"]/.test(x) ? `'${x}'` : x)).join(' ')}`);
    return { files: [], commands: cmds.map((c) => redact(c, key)), _cmds: r.commands({ url, key, model: opts.model }), notes: r.notes };
  }
  const files = partsOf(r).map((p) => {
    const before = readText(p.file);
    const { text, prev } = p.plan(before, { url, key, models: opts.models || [], model: opts.model, fastModel: opts.fastModel });
    return { key: p.key, abs: p.file, file: p.file.replace(home(), '~'), before: redact(before, key), after: redact(text, key), before_raw: before, changed: text !== before, _text: text, _prev: prev };
  });
  return { files, notes: r.notes };
}

// What the renderer may see: masked text only (no raw key, no internal _fields).
function previewPublic(id, opts) {
  const p = preview(id, opts);
  return { notes: p.notes, commands: p.commands || null, files: (p.files || []).map((f) => ({ file: f.file, before: f.before, after: f.after, changed: f.changed })) };
}

async function writeAtomic(file, text, defaultMode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let mode = defaultMode;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const tmp = `${file}.hm-${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, { mode });
  await fsp.rename(tmp, file);
}
async function snapshot(id, abs, label) {
  if (!fs.existsSync(abs)) return null;
  const h = core.byId(id);
  const it = h.items.find((x) => core.expand(x.path) === abs);
  return it ? core.createBackup(id, [it.path], { label }) : null;
}

async function connect(id, opts = {}) {
  const p = preview(id, opts);
  const r = recipeFor(id);
  if (r.command) {
    let out = '';
    const sn = await snapshot(id, r.file(), 'pre-connect');
    for (const [c, a] of p._cmds) {
      const res = await core.runCapture(c, a);
      out += redact(res.out, opts.key || getSettings().key);
      if (res.code !== 0) throw new Error(`${c} ${a[0]} ${a[1]} failed (exit ${res.code}): ${out.trim().split('\n').pop()}`);
    }
    return { files: [], commands: p.commands, output: out.trim(), snapshots: sn ? [sn.name] : [] };
  }
  const st = readJson(stateFile(), {});
  // Re-connecting must keep the ORIGINAL values so Disconnect restores them, not the proxy's.
  const already = r.detect(p.files[0].before_raw).connected && st[id];
  const snaps = [];
  const prevAll = {};
  for (const f of p.files) {
    if (!f.changed) { prevAll[f.key] = (already && st[id][f.key]) || f._prev; continue; }
    const sn = await snapshot(id, f.abs, 'pre-connect'); if (sn) snaps.push(sn.name);
    await writeAtomic(f.abs, f._text);
    prevAll[f.key] = already ? st[id][f.key] : f._prev;
  }
  st[id] = { ...prevAll, at: new Date().toISOString() };
  writeJson600(stateFile(), st);
  return { files: p.files.map((f) => f.file), snapshots: snaps };
}

async function disconnect(id) {
  const r = recipeFor(id);
  if (r.command) throw new Error('Disconnect is not automated for this harness — remove providers.cliproxyapi with its own CLI.');
  const st = readJson(stateFile(), {});
  const changedFiles = [], snaps = [];
  for (const p of partsOf(r)) {
    const before = readText(p.file);
    const text = p.undo(before, (st[id] || {})[p.key] || {});
    if (text === before) continue;
    const sn = await snapshot(id, p.file, 'pre-disconnect'); if (sn) snaps.push(sn.name);
    await writeAtomic(p.file, text);
    changedFiles.push(p.file.replace(home(), '~'));
  }
  return { changed: changedFiles.length > 0, files: changedFiles, snapshots: snaps };
}

// The editor must never receive the proxy key: swap it for a sentinel on read and back on save.
const SENTINEL = '__CLIPROXYAPI_KEY__';
const maskInText = (t) => { const k = getSettings().key; return k && t ? t.split(k).join(SENTINEL) : t; };
const unmaskInText = (t) => {
  if (!t.includes(SENTINEL)) return t;
  const k = getSettings().key;
  if (!k) throw new Error(`${SENTINEL} is a placeholder for the saved CLIProxyAPI key, but no key is saved.`);
  return t.split(SENTINEL).join(k);
};
function allStatuses() { const o = {}; for (const id of supported()) o[id] = status(id); return o; }
const publicSettings = () => { const { url, hasKey, keyMasked, configured } = getSettings(); return { url, hasKey, keyMasked, configured }; };
async function copyKeyTo(clipboard) { const k = getSettings().key; if (!k) throw new Error('No key saved.'); clipboard.writeText(k); return true; }
// Text models only (image/embedding ids make no sense as a default chat model).
const isChatModel = (id) => !/image|embed|tts|whisper|moderation/i.test(id);

module.exports = {
  skipSetup, maskInText, unmaskInText, SENTINEL, previewPublic, allStatuses, publicSettings, copyKeyTo, isChatModel, recipes, supported, status, preview, connect, disconnect, getSettings, saveSettings, testConnection, listModels, normUrl, mask, stripBlock, MARK_A };
