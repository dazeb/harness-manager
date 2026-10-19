'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'tip') n.setAttribute('data-tip', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const help = (text) => el('span', { class: 'help', tip: text, tabindex: '0', 'aria-label': text }, '?');
const add = (parent, ...kids) => parent.append(...kids.flat().filter((k) => k != null && k !== false));
const fmt = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const api = async (p) => { const r = await p; if (!r.ok) throw new Error(r.error); return r.data; };


// ---------- tooltips: one floating bubble for every [data-tip] element ----------
const tipEl = el('div', { id: 'tip', hidden: true }); document.body.append(tipEl);
let tipTimer = null;
function showTip(t) {
  const r = t.getBoundingClientRect();
  tipEl.textContent = t.getAttribute('data-tip'); tipEl.hidden = false;
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  let y = r.bottom + 6; if (y + h > innerHeight - 8) y = r.top - h - 6;
  tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
}
const hideTip = () => { clearTimeout(tipTimer); tipEl.hidden = true; };
document.addEventListener('mouseover', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (!t) return hideTip(); clearTimeout(tipTimer); tipTimer = setTimeout(() => showTip(t), t.classList.contains('help') ? 80 : 350); });
document.addEventListener('focusin', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) showTip(t); });
document.addEventListener('focusout', hideTip); document.addEventListener('mousedown', hideTip); document.addEventListener('scroll', hideTip, true);

let harnesses = [], updates = {}, filter = 'all', checking = false, pstat = {}, pset = { url: '', hasKey: false };
const status = (t) => { $('#status').textContent = t; };

// ---------- table ----------
function render() {
  const inst = harnesses.filter((h) => h.installed), miss = harnesses.filter((h) => !h.installed);
  const upd = harnesses.filter((h) => updates[h.id] && updates[h.id].status === 'update');
  $('#n-all').textContent = harnesses.length; $('#n-installed').textContent = inst.length;
  $('#n-missing').textContent = miss.length; $('#n-updates').textContent = upd.length;
  const list = { all: harnesses, installed: inst, missing: miss, updates: upd }[filter];
  const rows = $('#rows'); rows.replaceChildren();
  $('#empty').hidden = list.length > 0;
  for (const h of list) {
    const u = updates[h.id];
    let latest = el('span', { class: 'badge none', text: h.installed && h.canCheck ? '—' : '' });
    if (u) {
      if (u.status === 'update') latest = el('span', { class: 'badge update', text: `↑ ${u.latest}`, tip: `Update available: ${h.version || '?'} → ${u.latest}. Press Update to install it.` });
      else if (u.status === 'current') latest = el('span', { class: 'badge current', text: 'up to date', tip: 'You have the newest release.' });
      else if (u.error) latest = el('span', { class: 'badge err', text: 'check failed', tip: `Couldn't check for updates: ${u.error}` });
      else latest = el('span', { class: 'badge none', text: u.latest || '?' });
    }
    const acts = h.installed
      ? [el('button', { text: 'Backup', tip: 'Save this harness\'s config files to a .tar.gz archive. Chats, logs and caches are never included.', onclick: () => backupDialog(h) }), el('button', { text: 'Restore', tip: 'Put a saved backup back. You\'ll see which files change first, and the current versions are snapshotted before anything is overwritten.', onclick: () => restoreDialog(h) }),
         el('button', { text: 'Edit', tip: 'Open this harness\'s config files in a built-in editor. Syntax is checked before saving and the previous version is kept as .hm.bak.', onclick: () => editDialog(h) }),
         el('button', { text: 'Proxy', tip: 'Point this harness at your CLIProxyAPI gateway (shows a preview first; can be undone with Disconnect).', onclick: () => proxyDialog(h) }),
         el('button', { text: 'Update', tip: h.updateCmd ? `Runs this harness's own upgrade command after you confirm:\n${h.updateCmd}` : 'No update command is known for this harness.', class: u && u.status === 'update' ? 'primary' : '', disabled: !h.updateCmd || !h.binary, onclick: () => updateDialog(h) })]
      : [el('button', { text: 'Install…', tip: 'Not installed. Shows a suggested install command you can copy. You can still restore an old backup of its config.', onclick: () => installDialog(h) })];
    // Not-installed harnesses can still restore a previous backup.
    if (!h.installed) acts.unshift(el('button', { text: 'Restore', onclick: () => restoreDialog(h) }));
    const hint = h.signal + (h.alts && h.alts.length ? '\nAlso found:\n' + h.alts.join('\n') : '');
    rows.append(el('tr', { class: h.installed ? '' : 'missing' },
      el('td', { class: 'c-dot' }, el('span', { class: `dot ${h.binary ? 'on' : h.installed ? 'cfg' : ''}`, tip: h.binary ? 'Installed — the executable was found.' : h.installed ? 'Config only — settings exist but no executable was found on your PATH.' : 'Not installed.' })),
      el('td', { class: 'c-name' }, el('span', { class: 'name', text: h.name }), el('span', { class: 'desc', text: h.desc }),
        pstat[h.id] && pstat[h.id].connected ? el('span', { class: pstat[h.id].stale ? 'tag warnt' : 'tag okt', text: pstat[h.id].stale ? 'proxy: other URL' : '→ CLIProxyAPI', tip: pstat[h.id].stale ? `This harness points at ${pstat[h.id].url}, which differs from the CLIProxyAPI address you saved.` : `Already configured to use CLIProxyAPI at ${pstat[h.id].url}.` }) : null),
      el('td', { class: 'c-ver', text: h.version || (h.installed ? '?' : '') }),
      el('td', { class: 'c-latest' }, latest),
      el('td', { class: 'c-loc' }, el('span', { class: 'loc', text: h.binPath ? h.binPath.replace(/^\/home\/[^/]+/, '~') : (h.installed ? h.configDir : ''), tip: h.binPath || h.configDir }),
        !h.binary && h.installed ? el('span', { class: 'tag', text: 'config only', tip: 'No executable found, but its config folder exists (e.g. installed elsewhere, or only the app\'s settings).' }) : null,
        h.alts && h.alts.length ? el('span', { class: 'tag', text: `+${h.alts.length}`, tip: 'Other copies of this program were found:\n' + h.alts.join('\n') + '\nThe one shown is the one used.' }) : null),
      el('td', { class: 'actions' }, acts)));
  }
}

async function loadProxy() {
  try { pstat = await api(window.hm.proxyStatuses()); pset = await api(window.hm.proxySettings()); } catch {}
}
async function scan() {
  status('Scanning…');
  try { harnesses = await api(window.hm.detect()); } catch (e) { status(`Scan failed: ${e.message}`); return; }
  await loadProxy();
  render();
  status(`${harnesses.filter((h) => h.installed).length} installed, ${harnesses.filter((h) => !h.installed).length} not installed`);
}
async function check(force) {
  if (checking) return; checking = true; $('#btn-check').disabled = true; status('Checking for updates…');
  try { updates = await api(window.hm.checkUpdates(force)); const n = Object.values(updates).filter((u) => u.status === 'update').length; status(n ? `${n} update${n > 1 ? 's' : ''} available` : 'Everything checked is up to date'); }
  catch (e) { status(`Update check failed: ${e.message}`); }
  checking = false; $('#btn-check').disabled = false; render();
}

// ---------- modal ----------
let modalLocked = false;
function modal(title, body, foot, { locked = false } = {}) {
  modalLocked = locked;
  const card = $('#card'); card.replaceChildren(el('h2', { text: title }), el('div', { class: 'body' }, body), el('div', { class: 'foot' }, foot));
  $('#modal').hidden = false;
}
const closeModal = () => { modalLocked = false; $('#modal').hidden = true; $('#card').replaceChildren(); };
const closeBtn = (t = 'Close') => el('button', { text: t, onclick: closeModal });
const msgEl = () => el('span', { class: 'msg' });

// ---------- backup ----------
function backupDialog(h) {
  const boxes = [];
  const body = el('div', {}, el('p', { class: 'sub' }, 'Pick what to include. Backups are saved as .tar.gz archives; sessions, logs and caches are never captured.', help('Backups go to ~/backups/harness-configs/<harness>/. Each archive has a manifest with file hashes, so a restore can tell which files changed.')));
  for (const it of h.items) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = it.exists && !it.secret && !it.heavy; cb.disabled = !it.exists;
    boxes.push({ cb, it });
    body.append(el('label', { class: `item ${it.exists ? '' : 'missing'}` }, cb, it.label,
      it.secret ? el('span', { class: 'tag secret', text: 'credentials', tip: 'Contains logins or API keys. Off by default; if included, the archive is private (mode 600) — keep it safe.' }) : null, it.heavy ? el('span', { class: 'tag', text: 'large', tip: 'Skills/plugins can be big. Off by default — tick it to include them.' }) : null,
      el('span', { class: 'sz', text: it.exists ? fmt(it.size) : 'not present' })));
  }
  const warn = el('div', { class: 'warn' });
  const upd = () => { warn.textContent = boxes.some((b) => b.cb.checked && b.it.secret) ? 'Credentials selected — the archive will contain tokens (file mode 0600). Keep it private.' : ''; };
  body.addEventListener('change', upd); body.append(warn);
  const msg = msgEl(); const go = el('button', { class: 'primary', text: 'Create backup' });
  go.onclick = async () => {
    const paths = boxes.filter((b) => b.cb.checked).map((b) => b.it.path);
    if (!paths.length) { msg.textContent = 'Select at least one item.'; return; }
    go.disabled = true; msg.textContent = 'Working…';
    try { const r = await api(window.hm.backup(h.id, paths)); msg.textContent = `Saved ${r.files} files (${fmt(r.size)}) → ${r.name}`; }
    catch (e) { msg.textContent = e.message; } go.disabled = false;
  };
  modal(`Backup — ${h.name}`, body, [msg, closeBtn(), go]);
}

// ---------- restore ----------
async function restoreDialog(h) {
  const body = el('div'); const msg = msgEl(); const go = el('button', { class: 'primary', text: 'Restore', disabled: true });
  const del = el('button', { class: 'danger', text: 'Delete', disabled: true });
  modal(`Restore — ${h.name}`, body, [msg, del, closeBtn(), go]);
  let sel = null;
  const draw = async () => {
    body.replaceChildren(); sel = null; go.disabled = del.disabled = true;
    let list; try { list = await api(window.hm.listBackups(h.id)); } catch (e) { body.append(e.message); return; }
    if (!list.length) { body.append(el('p', { class: 'sub', text: 'No backups yet for this harness.' })); return; }
    const preview = el('div');
    for (const b of list) {
      const row = el('div', { class: 'bk' }, el('b', { text: b.label }), b.createdAt ? new Date(b.createdAt).toLocaleString() : b.name,
        b.version ? el('span', { class: 'tag', text: `v${b.version}`, tip: 'Version of the harness when this backup was made.' }) : null, b.label === 'pre-restore' || b.label === 'pre-connect' || b.label === 'pre-disconnect' ? help(b.label === 'pre-restore' ? 'Automatic snapshot taken just before a restore, so you can undo it.' : 'Automatic snapshot taken just before changing the config for CLIProxyAPI.') : null, b.includesSecrets ? el('span', { class: 'tag secret', text: 'credentials' }) : null,
        el('span', { class: 'sub', text: `${b.files} files · ${fmt(b.size)}` }));
      row.onclick = async () => {
        if (b.broken) return;
        body.querySelectorAll('.bk').forEach((n) => n.classList.remove('on')); row.classList.add('on'); sel = b;
        preview.replaceChildren(el('p', { class: 'sub', text: 'Comparing with files on disk…' }));
        try {
          const p = await api(window.hm.previewRestore(h.id, b.archive));
          const n = p.changes.filter((c) => c.state !== 'same').length;
          preview.replaceChildren(el('p', { class: 'sub' }, n ? `${n} file(s) will be written. Changed files are snapshotted first (label "pre-restore").` : 'Everything already matches this backup.', help('new = file is missing now and will be recreated · changed = differs from the backup and will be overwritten · same = identical, left alone.')),
            ...p.changes.map((c) => el('div', { class: 'change' }, el('b', { class: c.state, text: c.state }), c.path)));
          go.disabled = !n; del.disabled = false;
        } catch (e) { preview.replaceChildren(el('p', { class: 'warn', text: e.message })); }
      };
      body.append(row);
    }
    body.append(preview);
  };
  go.onclick = async () => {
    if (!sel) return; go.disabled = true; msg.textContent = 'Restoring…';
    try { const r = await api(window.hm.restore(h.id, sel.archive)); msg.textContent = `Restored ${r.restored} file(s)` + (r.snapshot ? ` · previous state saved as ${r.snapshot.name}` : ''); await draw(); }
    catch (e) { msg.textContent = e.message; go.disabled = false; }
  };
  del.onclick = async () => {
    if (!sel || !confirm(`Delete backup ${sel.name}?`)) return;
    try { await api(window.hm.deleteBackup(h.id, sel.archive)); msg.textContent = 'Deleted.'; await draw(); } catch (e) { msg.textContent = e.message; }
  };
  draw();
}

// ---------- edit ----------
async function editDialog(h) {
  let files; try { files = await api(window.hm.editableFiles(h.id)); } catch (e) { modal(`Edit — ${h.name}`, e.message, [closeBtn()]); return; }
  const list = el('div', { class: 'files' }), ta = el('textarea', { spellcheck: 'false', disabled: true }), err = el('div', { class: 'err' });
  const save = el('button', { class: 'primary', text: 'Save', disabled: true }), msg = msgEl();
  let cur = null, dirty = false, timer;
  const body = el('div', {}, h.note ? el('p', { class: 'warn', text: h.note }) : null, el('p', { class: 'sub' }, 'Pick a file on the left. Syntax is checked as you type; saving keeps the old version as <file>.hm.bak.', help('Credential files (auth.json, .env…) are never shown here, and API keys saved for CLIProxyAPI appear as a placeholder, so nothing secret is exposed in this editor.')), el('div', { class: 'split' }, list, el('div', { class: 'edpane' }, err, ta)));
  modal(`Edit — ${h.name}`, body, [msg, closeBtn(), save]);
  const open = async (f, btn) => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    list.querySelectorAll('button').forEach((b) => b.classList.remove('on')); btn.classList.add('on');
    try {
      const r = await api(window.hm.readConfig(h.id, f.path));
      cur = f; ta.value = r.text; ta.disabled = r.readonly; save.disabled = r.readonly; dirty = false;
      err.textContent = r.readonly ? 'Read-only (managed by the harness).' : r.error ? `Syntax: ${r.error}` : (r.exists ? '' : 'New file — saving will create it.');
      msg.textContent = f.path;
    } catch (e) { err.textContent = e.message; }
  };
  let group = null;
  for (const f of files) {
    if (f.group !== group) { group = f.group; list.append(el('div', { class: 'grp', text: group === 'config' ? 'Config' : group })); }
    const b = el('button', { text: f.label + (f.exists ? '' : ' (new)'), onclick: () => open(f, b) }); list.append(b);
  }
  ta.addEventListener('input', () => {
    dirty = true; clearTimeout(timer);
    timer = setTimeout(async () => { if (!cur) return; try { const e = await api(window.hm.validate(cur.path, ta.value)); err.textContent = e ? `Syntax: ${e}` : ''; } catch {} }, 250);
  });
  save.onclick = async () => {
    if (!cur) return; save.disabled = true;
    try { await api(window.hm.saveConfig(h.id, cur.path, ta.value)); dirty = false; msg.textContent = `Saved ${cur.path} (previous version kept as .hm.bak)`; err.textContent = ''; }
    catch (e) { err.textContent = e.message; } save.disabled = false;
  };
}

// ---------- update / install ----------
function logDialog(title, cmdText, runner) {
  const log = el('pre', { class: 'log' }), msg = msgEl(), close = closeBtn();
  modal(title, el('div', {}, el('p', {}, el('code', { text: cmdText })), log), [msg, close]);
  return { log, msg, close };
}
async function updateDialog(h) {
  const u = updates[h.id];
  const ui = logDialog(`Update — ${h.name}`, h.updateCmd, null);
  ui.msg.textContent = u && u.status === 'update' ? `${h.version} → ${u.latest}` : (h.version ? `Current: ${h.version}` : '');
  window.hm.onRunOutput((m) => { if (m.id === h.id) { ui.log.textContent += m.chunk; ui.log.scrollTop = ui.log.scrollHeight; } });
  try {
    const r = await api(window.hm.runUpdate(h.id));
    if (r.cancelled) { closeModal(); return; }
    ui.msg.textContent = r.code === 0 ? 'Finished successfully.' : `Exited with code ${r.code}.`;
    await scan(); await check(true);
  } catch (e) { ui.log.textContent = e.message; }
}
function installDialog(h) {
  const body = el('div', {}, el('p', { text: h.desc }), el('p', { class: 'sub', text: 'Suggested install command:' }), el('p', {}, el('code', { text: h.installCmd })),
    h.homepage ? el('p', {}, el('a', { href: '#', text: h.homepage, onclick: (e) => { e.preventDefault(); window.hm.openExternal(h.homepage); } })) : null);
  modal(`Install — ${h.name}`, body, [closeBtn(), el('button', { text: 'Copy command', class: 'primary', onclick: () => window.hm.copy(h.installCmd) })]);
}


// ---------- CLIProxyAPI ----------
function lineDiff(b, a) {
  // Trim the common head/tail, then LCS on the middle (fine for config-sized files).
  let s = 0; while (s < b.length && s < a.length && b[s] === a[s]) s++;
  let e = 0; while (e < b.length - s && e < a.length - s && b[b.length - 1 - e] === a[a.length - 1 - e]) e++;
  const x = b.slice(s, b.length - e), y = a.slice(s, a.length - e);
  const ops = b.slice(0, s).map((t) => ['=', t]);
  if (x.length * y.length > 16e6) { x.forEach((t) => ops.push(['-', t])); y.forEach((t) => ops.push(['+', t])); }
  else {
    const w = y.length + 1, L = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) for (let k = y.length - 1; k >= 0; k--)
      L[i * w + k] = x[i] === y[k] ? L[(i + 1) * w + k + 1] + 1 : Math.max(L[(i + 1) * w + k], L[i * w + k + 1]);
    let i = 0, k = 0;
    while (i < x.length && k < y.length) {
      if (x[i] === y[k]) { ops.push(['=', x[i]]); i++; k++; }
      else if (L[(i + 1) * w + k] >= L[i * w + k + 1]) ops.push(['-', x[i++]]); else ops.push(['+', y[k++]]);
    }
    while (i < x.length) ops.push(['-', x[i++]]);
    while (k < y.length) ops.push(['+', y[k++]]);
  }
  b.slice(b.length - e).forEach((t) => ops.push(['=', t]));
  return ops;
}
function diffView(before, after) {
  const ops = lineDiff(before.split('\n'), after.split('\n')), keep = new Set();
  ops.forEach((o, i) => { if (o[0] !== '=') for (let d = -2; d <= 2; d++) keep.add(i + d); });
  const out = []; let gap = false;
  ops.forEach((o, i) => {
    if (!keep.has(i)) { gap = true; return; }
    if (gap && out.length) out.push(el('div', { class: 'ln ctx', text: '  …' }));
    gap = false;
    out.push(el('div', { class: `ln ${o[0] === '+' ? 'add' : o[0] === '-' ? 'del' : 'ctx'}`, text: `${o[0] === '=' ? ' ' : o[0]} ${o[1]}` }));
  });
  return el('pre', { class: 'log diff' }, ...out);
}
function proxySettingsDialog() {
  const url = el('input', { type: 'text', value: pset.url, placeholder: 'localhost  or  192.168.1.50  or  http://host:8317', spellcheck: 'false' });
  const key = el('input', { type: 'password', placeholder: pset.hasKey ? `saved (${pset.keyMasked}) — leave blank to keep` : 'API key (api-keys in the proxy config)', spellcheck: 'false' });
  const out = el('div', { class: 'sub' }), msg = msgEl();
  const test = el('button', { text: 'Test connection' }), save = el('button', { class: 'primary', text: 'Save' });
  test.onclick = async () => {
    out.textContent = 'Testing…';
    try { const t = await api(window.hm.proxyTest(url.value, key.value)); out.textContent = `Connected — ${t.count} models (${Object.entries(t.owners).map(([k, v]) => `${k} ${v}`).join(', ')})`; out.className = 'sub okc'; }
    catch (e) { out.textContent = e.message; out.className = 'sub errc'; }
  };
  save.onclick = async () => {
    try { pset = await api(window.hm.proxySave({ url: url.value, key: key.value })); msg.textContent = 'Saved.'; render(); } catch (e) { msg.textContent = e.message; }
  };
  modal('CLIProxyAPI connection', el('div', {},
    el('p', { class: 'sub', text: 'CLIProxyAPI turns your CLI logins (Codex, Claude, Gemini…) into one OpenAI/Claude/Gemini-compatible endpoint. Set where it runs; each harness can then be pointed at it with its "Proxy" button.' }),
    el('label', { class: 'field' }, el('span', {}, 'Base URL', help('Where CLIProxyAPI is listening, e.g. http://127.0.0.1:8317 for this computer or http://192.168.1.50:8317 for another machine. The default port is 8317.')), url), el('label', { class: 'field' }, el('span', {}, 'API key', help('One of the api-keys in the proxy\'s config.yaml. Harnesses send it as their bearer/API key. Stored privately (mode 600) and written into a harness config only when you press Connect.')), key), out,
    el('p', { class: 'sub', text: 'Saved to ~/.config/harness-manager/settings.json (mode 600). The key is written into a harness\'s config only when you press Connect.' })),
    [msg, closeBtn(), test, save]);
}

async function proxyDialog(h) {
  const st = pstat[h.id];
  if (!st || !st.supported) { manualProxyDialog(h); return; }
  if (!pset.hasKey) { proxySettingsDialog(); return; }
  const body = el('div'), msg = msgEl();
  const apply = el('button', { class: 'primary', text: st.connected ? 'Re-apply' : 'Connect' });
  const off = el('button', { class: 'danger', text: 'Disconnect', hidden: !st.connected || h.id === 'hermes' });
  modal(`CLIProxyAPI — ${h.name}`, body, [msg, off, closeBtn(), apply]);
  let models = [], chosen = null, previewBox = el('div');
  add(body, el('p', { class: 'sub', text: st.notes }),
    st.connected ? el('p', { class: st.stale ? 'warn' : 'sub okc', text: st.stale ? `Currently points at ${st.url}, which differs from the saved proxy URL.` : `Connected → ${st.url}` }) : null);
  try { models = (await api(window.hm.proxyTest('', ''))).models.map((m) => m.id); }
  catch (e) { body.append(el('p', { class: 'warn', text: `Can't reach the proxy: ${e.message}` })); }
  const wantsModel = ['claude', 'hermes', 'gemini'].includes(h.id);
  const pool = h.id === 'gemini' ? models.filter((m) => m.startsWith('gemini')) : models;
  if (wantsModel && pool.length) {
    const first = h.id === 'gemini' ? (pool.find((m) => m === 'gemini-3.8-flash-high') || pool[0]) : null;
    if (first) chosen = first;
    const sel = el('select', {}, ...(h.id === 'gemini' ? [] : [el('option', { value: '', text: h.id === 'claude' ? 'Keep my current model' : 'gpt-6-luna (default)' })]), ...pool.map((m) => el('option', { value: m, text: m, selected: m === first })));
    sel.onchange = () => { chosen = sel.value || null; refresh(); };
    add(body, el('label', { class: 'field' }, el('span', {}, h.id === 'claude' ? 'Default model through the proxy' : 'Default model', help('The model this harness will use by default once it talks to the proxy. The list comes from the proxy itself (/v1/models).')), sel),
      h.id === 'claude' ? el('p', { class: 'sub', text: 'Claude Code asks for Anthropic model names; pick a model the proxy serves (it will also be used for background tasks).' }) : null);
  }
  if (h.id === 'gemini') add(body, el('p', { class: 'warn', text: 'Gemini only reads ~/.gemini/.env in folders it trusts. In an untrusted folder it will say the API key is missing — Disconnect restores Google login.' }));
  body.append(previewBox);
  const opts = () => ({ models: h.id === 'opencode' ? models : [], model: chosen || undefined, fastModel: h.id === 'claude' ? chosen || undefined : undefined });
  async function refresh() {
    previewBox.replaceChildren(el('p', { class: 'sub', text: 'Changes that will be made:' }));
    try {
      const p = await api(window.hm.proxyPreview(h.id, opts()));
      if (p.commands) previewBox.append(el('pre', { class: 'log', text: p.commands.join('\n') }));
      for (const f of p.files) add(previewBox, el('div', { class: 'sub', text: f.file + (f.changed ? '' : ' — already up to date') }), f.changed ? diffView(f.before, f.after) : null);
      apply.disabled = false;
    } catch (e) { previewBox.append(el('p', { class: 'warn', text: e.message })); apply.disabled = true; }
  }
  apply.onclick = async () => {
    apply.disabled = true; msg.textContent = 'Applying…';
    try {
      const r = await api(window.hm.proxyConnect(h.id, opts()));
      msg.textContent = 'Connected.' + (r.snapshots && r.snapshots.length ? ` Previous config backed up (${r.snapshots[0]}).` : '');
      await loadProxy(); render();
    } catch (e) { msg.textContent = e.message; apply.disabled = false; }
  };
  off.onclick = async () => {
    if (!confirm(`Remove the CLIProxyAPI settings from ${h.name}?`)) return;
    try { const r = await api(window.hm.proxyDisconnect(h.id)); msg.textContent = r.changed ? 'Disconnected — original settings restored.' : 'Nothing to change.'; await loadProxy(); render(); }
    catch (e) { msg.textContent = e.message; }
  };
  refresh();
}

function manualProxyDialog(h) {
  const u = pset.url || 'http://<host>:8317';
  const row = (label, val) => el('div', { class: 'kv' }, el('span', { class: 'k', text: label }), el('code', { text: val }), el('button', { text: 'Copy', onclick: () => window.hm.copy(val) }));
  modal(`CLIProxyAPI — ${h.name}`, el('div', {},
    el('p', { class: 'sub', text: `One-click setup isn't built for ${h.name} yet. In its provider/endpoint settings, use whichever style it supports:` }),
    row('OpenAI-compatible', `${u}/v1`), row('Anthropic-compatible', u), row('Gemini-compatible', u),
    el('p', { class: 'sub', text: 'Use your proxy API key as the key / auth token.' }),
    el('p', {}, el('button', { text: 'Copy API key', disabled: !pset.hasKey, onclick: async () => { await api(window.hm.proxyCopyKey()); } }),
      !pset.hasKey ? el('span', { class: 'sub', text: '  Save a key under "CLIProxyAPI" first.' }) : null)),
    [closeBtn()]);
}


// ---------- first-run: where is CLIProxyAPI? ----------
function setupDialog() {
  return new Promise((resolve) => {
    const choice = { v: 'local' };
    const lanInput = el('input', { type: 'text', placeholder: '192.168.1.50   or   http://192.168.1.50:8317', spellcheck: 'false', disabled: true });
    const key = el('input', { type: 'password', placeholder: 'API key (optional now — needed to connect harnesses)', spellcheck: 'false' });
    const out = el('div', { class: 'sub' }), msg = msgEl();
    const opt = (v, title, sub) => {
      const r = el('input', { type: 'radio', name: 'where', value: v }); r.checked = v === choice.v;
      r.onchange = () => { choice.v = v; lanInput.disabled = v !== 'lan'; if (v === 'lan') lanInput.focus(); };
      return el('label', { class: 'opt' }, r, el('span', {}, el('b', { text: title }), el('span', { class: 'sub', text: ` — ${sub}` })));
    };
    const address = () => (choice.v === 'local' ? 'http://127.0.0.1:8317' : lanInput.value);
    const test = el('button', { text: 'Test connection' }), go = el('button', { class: 'primary', text: 'Save & continue' }), skip = el('button', { text: 'Skip for now' });
    test.onclick = async () => {
      out.className = 'sub'; out.textContent = 'Testing…';
      try {
        const t = await api(window.hm.proxyTest(address(), key.value));
        out.textContent = `Reachable — ${t.count} models (${Object.entries(t.owners).map(([k, v]) => `${k} ${v}`).join(', ')})`; out.className = 'sub okc';
      } catch (e) { out.textContent = e.message; out.className = 'sub errc'; }
    };
    go.onclick = async () => {
      try { pset = await api(window.hm.proxySave({ url: address(), key: key.value })); closeModal(); resolve(); }
      catch (e) { msg.textContent = e.message; }
    };
    skip.onclick = async () => { try { pset = await api(window.hm.proxySkip()); } catch {} closeModal(); resolve(); };
    modal('Where is your CLIProxyAPI?', el('div', {},
      el('p', {}, 'CLIProxyAPI is the gateway that turns your CLI logins (Codex, Claude, Gemini…) into one OpenAI/Claude/Gemini-compatible endpoint. Harness Manager can point each of your harnesses at it. Where does it run?'),
      opt('local', 'On this computer', 'http://127.0.0.1:8317'),
      opt('lan', 'On another machine (LAN or server)', 'enter its IP or hostname'),
      el('label', { class: 'field' }, el('span', {}, 'Address', help('IP address or hostname of the machine running CLIProxyAPI. Port 8317 is assumed if you leave it out.')), lanInput),
      el('label', { class: 'field' }, el('span', {}, 'API key', help('Optional now. You need it to connect harnesses; find it under api-keys in the proxy\'s config.yaml.')), key), out,
      el('p', { class: 'sub', text: 'You can change this any time with the CLIProxyAPI button. Don\'t use it? Skip — everything else works without it.' })),
      [msg, skip, test, go], { locked: true });
  });
}

async function init() {
  await loadProxy();
  if (!pset.configured) await setupDialog(); // asked first, before anything else
  await scan();
  check(false);
}

// ---------- wiring ----------
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  filter = b.dataset.f; document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b)); render();
});
$('#btn-refresh').onclick = async () => { await scan(); };
$('#btn-check').onclick = () => check(true);
$('#btn-proxy').onclick = proxySettingsDialog;
$('#btn-open').onclick = () => api(window.hm.openBackups()).catch((e) => status(e.message));
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal' && !modalLocked) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden && !modalLocked) closeModal(); });
window.hm.onUpdateResult(({ id, r }) => { updates[id] = r; render(); });
init();

if (localStorage.getItem('hm-intro-hidden')) $('#intro').hidden = true;
$('#intro-x').onclick = () => { $('#intro').hidden = true; localStorage.setItem('hm-intro-hidden', '1'); };
