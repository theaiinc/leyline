/** The owner's page for handing out Leyline API keys (hosted mode): plain HTML, a little script, no build step. */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function adminPage(v: { email: string; publicUrl: string; models: string[]; aliases: Record<string, string> }): string {
  const base = v.publicUrl.replace(/\/+$/, '');
  const firstModel = v.models[0] ?? 'auto';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leyline keys</title>
<style>
:root{color-scheme:light dark;--bg:#0b0d12;--panel:#12151d;--line:#232838;--text:#eef1f7;--soft:#c3c9d6;--muted:#8a93a6;--accent:#6c8cff;--warn:#ff9b8f;--ok:#5fd39a}
@media (prefers-color-scheme: light){:root{--bg:#f6f7fb;--panel:#fff;--line:#dfe3ec;--text:#141824;--soft:#353c4d;--muted:#6b7385;--accent:#3557e8;--warn:#c33d2e;--ok:#18864f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 64px}header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:28px 0 10px}.muted{color:var(--muted);font-size:13px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:14px}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}input{font:inherit;color:var(--text);background:transparent;border:1px solid var(--line);border-radius:9px;padding:8px 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
button{font:inherit;color:var(--text);background:transparent;border:1px solid var(--line);border-radius:9px;padding:8px 14px;cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px}
.tag{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;white-space:nowrap}.revoked{color:var(--warn)}.active{color:var(--ok)}
pre{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:10px;overflow:auto;font-size:13px;margin:6px 0}
.newkey{border-color:var(--accent)}code{font-size:13px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.scroll{overflow-x:auto}
</style></head><body><main>
<header><div><h1>Leyline keys</h1><div class="muted">API keys you hand out for coding agents · ${esc(base)}</div></div>
<div class="row"><span class="muted">${esc(v.email)}</span><button id="out">Sign out</button></div></header>

<section class="card"><h2 style="margin-top:0">New key</h2>
<form id="create" class="grid">
<label>Name (who it's for)<input name="name" required maxlength="80" placeholder="e.g. Minh — Claude Code"></label>
<label>Tokens a month<input name="tokensPerMonth" type="number" min="1" placeholder="no limit"></label>
<label>Requests a day<input name="requestsPerDay" type="number" min="1" placeholder="no limit"></label>
<label>Requests a minute<input name="requestsPerMinute" type="number" min="1" placeholder="no limit"></label>
<label>Models (comma, * allowed)<input name="models" placeholder="all offered"></label>
<label>&nbsp;<button class="primary" type="submit">Create key</button></label>
</form>
<div class="muted" style="margin-top:8px">Offered: ${esc(v.models.join(', ') || 'whatever the router picks')}${Object.keys(v.aliases).length ? ` · aliases: ${esc(Object.entries(v.aliases).map(([a, b]) => `${a} → ${b}`).join(', '))}` : ''}</div>
</section>

<section id="created" class="card newkey" hidden>
<h2 style="margin-top:0">Key created: copy it now, it won't be shown again</h2>
<div class="row"><pre id="keyval" style="flex:1"></pre><button id="copy">Copy</button></div>
<h2>Give them this</h2>
<div class="muted">Claude Code</div><pre id="sn-claude"></pre>
<div class="muted">Cursor, Codex, OpenCode, Cline, any OpenAI-compatible agent</div><pre id="sn-openai"></pre>
</section>

<h2>Keys</h2>
<div class="card scroll"><table><thead><tr><th>Name</th><th>Key</th><th>This month</th><th>Caps</th><th>Last used</th><th></th></tr></thead><tbody id="rows"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table></div>
</main>
<script>
const BASE = ${JSON.stringify(base)};
const FIRST = ${JSON.stringify(firstModel)};
const fmt = (n) => n == null ? '—' : Number(n).toLocaleString();
const when = (t) => t ? new Date(t).toLocaleString() : 'never';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
function caps(form) {
  const num = (k) => form[k].value ? Number(form[k].value) : null;
  const models = form.models.value.split(',').map((s) => s.trim()).filter(Boolean);
  return { tokensPerMonth: num('tokensPerMonth'), requestsPerDay: num('requestsPerDay'), requestsPerMinute: num('requestsPerMinute'), models: models.length ? models : null };
}
function capText(c) {
  const p = [];
  if (c.tokensPerMonth) p.push(fmt(c.tokensPerMonth) + ' tok/mo');
  if (c.requestsPerDay) p.push(fmt(c.requestsPerDay) + ' req/day');
  if (c.requestsPerMinute) p.push(fmt(c.requestsPerMinute) + ' req/min');
  if (c.models) p.push(c.models.join(', '));
  return p.length ? p.join(' · ') : 'no limits';
}
async function load() {
  const { keys } = await api('GET', '/admin/api/keys');
  const rows = document.getElementById('rows');
  if (!keys.length) { rows.innerHTML = '<tr><td colspan="6" class="muted">No keys yet.</td></tr>'; return; }
  rows.innerHTML = keys.map((k) => {
    const u = k.usage || {};
    const tokens = (u.promptTokens || 0) + (u.completionTokens || 0);
    const pct = k.caps.tokensPerMonth ? ' (' + Math.round(100 * tokens / k.caps.tokensPerMonth) + '%)' : '';
    return '<tr><td>' + esc(k.name) + (k.note ? '<div class="muted">' + esc(k.note) + '</div>' : '') + '<div class="muted">' + new Date(k.createdAt).toLocaleDateString() + '</div></td>'
      + '<td><code>' + esc(k.prefix) + '…</code><br><span class="tag ' + (k.revokedAt ? 'revoked">revoked' : 'active">active') + '</span></td>'
      + '<td>' + fmt(tokens) + ' tokens' + pct + '<div class="muted">' + fmt(u.requests || 0) + ' requests</div></td>'
      + '<td>' + esc(capText(k.caps)) + '</td><td class="muted">' + when(k.lastUsedAt) + '</td>'
      + '<td>' + (k.revokedAt ? '' : '<div class="row"><button data-edit="' + k.id + '">Caps</button><button class="danger" data-revoke="' + k.id + '">Revoke</button></div>') + '</td></tr>';
  }).join('');
  rows.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => {
    if (!confirm('Revoke this key? Agents using it stop working at once.')) return;
    await api('DELETE', '/admin/api/keys/' + b.dataset.revoke); load();
  });
  rows.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
    const k = keys.find((x) => x.id === b.dataset.edit);
    const ask = (label, v) => { const a = prompt(label + ' (empty = no limit)', v ?? ''); return a === null ? undefined : a.trim() === '' ? null : a; };
    const t = ask('Tokens a month', k.caps.tokensPerMonth); if (t === undefined) return;
    const d = ask('Requests a day', k.caps.requestsPerDay); if (d === undefined) return;
    const m = ask('Requests a minute', k.caps.requestsPerMinute); if (m === undefined) return;
    const mo = ask('Models (comma, * allowed)', (k.caps.models || []).join(', ')); if (mo === undefined) return;
    await api('PATCH', '/admin/api/keys/' + k.id, { caps: { tokensPerMonth: t && Number(t), requestsPerDay: d && Number(d), requestsPerMinute: m && Number(m), models: mo ? mo.split(',').map((s) => s.trim()).filter(Boolean) : null } });
    load();
  });
}
document.getElementById('create').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const { key } = await api('POST', '/admin/api/keys', { name: f.name.value, caps: caps(f) });
    document.getElementById('keyval').textContent = key;
    document.getElementById('sn-claude').textContent = 'export ANTHROPIC_BASE_URL=' + BASE + '\\nexport ANTHROPIC_AUTH_TOKEN=' + key + '\\nclaude';
    document.getElementById('sn-openai').textContent = 'Base URL:  ' + BASE + '/v1\\nAPI key:   ' + key + '\\nModel:     ' + FIRST;
    document.getElementById('created').hidden = false;
    f.reset(); load();
  } catch (err) { alert('Could not create the key: ' + err.message); }
};
document.getElementById('copy').onclick = () => navigator.clipboard.writeText(document.getElementById('keyval').textContent);
document.getElementById('out').onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); location.href = '/auth/login?next=/admin'; };
load().catch((err) => { document.getElementById('rows').innerHTML = '<tr><td colspan="6" class="revoked">' + esc(err.message) + '</td></tr>'; });
</script></body></html>`;
}
