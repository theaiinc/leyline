/**
 * The look of adm's server pages (Billing, Partners): the same colours, dark mode and header as the adm/dash React
 * apps (Valefront mint/blue on navy), so adm reads as one app. Styling only.
 */
export const ADMIN_PAGE_CSS = `:root{--bg:#f7f9fb;--fg:#14161b;--muted:#5c6470;--card:#fff;--border:#e3e7ee;--primary:#1f9d6b;--primary-fg:#fff;--accent:#e6f6ef;--ring:#3f72e0;--warn-bg:#fff6d6;--warn-bd:#e8d48a;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#10151d;--fg:#f2f4f7;--muted:#9aa4b2;--card:#171e29;--border:#263142;--primary:#a9f5cf;--primary-fg:#0b2a1d;--accent:#1c3a30;--ring:#7aa6ff;--warn-bg:#3a3114;--warn-bd:#6b5a1f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header.adm{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;padding:12px 24px;border-bottom:1px solid var(--border);background:var(--bg)}
header.adm .brand{display:flex;align-items:center;gap:9px;font-weight:600;color:var(--fg);text-decoration:none}header.adm .brand img{width:28px;height:28px}
.pill{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--primary);background:color-mix(in srgb,var(--primary) 16%,transparent);border-radius:999px;padding:2px 7px}
header.adm nav{display:flex;gap:4px;margin-left:auto;flex-wrap:wrap}header.adm nav a{color:var(--muted);text-decoration:none;padding:6px 11px;border-radius:999px;border:1px solid transparent}
header.adm nav a.on{background:var(--accent);color:var(--fg);font-weight:600}header.adm nav a:hover{border-color:var(--border)}
main{max-width:1200px;margin:0 auto;padding:28px 24px 64px}h1{font-size:24px;letter-spacing:-.01em;margin:0 0 6px}h2{font-size:16px;margin:32px 0 10px}
p{color:var(--muted)}p strong{color:var(--fg)}a{color:var(--ring)}small{color:var(--muted);overflow-wrap:anywhere}code{font-size:12px}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--border);border-radius:12px}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
td,th{padding:10px 12px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}tbody tr:last-child td{border-bottom:0}.n{text-align:right}
input,textarea,select{font:inherit;color:var(--fg);background:var(--bg);padding:7px 9px;border:1px solid var(--border);border-radius:8px;max-width:100%}
input:focus,textarea:focus,select:focus{outline:2px solid var(--ring);outline-offset:1px}
button{font:inherit;font-weight:600;padding:7px 12px;border-radius:8px;border:1px solid transparent;background:var(--primary);color:var(--primary-fg);cursor:pointer;margin:2px 0}button:hover{filter:brightness(1.06)}
form.settings{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;background:var(--card);padding:16px;border:1px solid var(--border);border-radius:12px}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
.note{padding:10px 14px;background:var(--warn-bg);border:1px solid var(--warn-bd);border-radius:10px;color:var(--fg)}
.wrap{overflow-x:auto}details{margin-top:6px}summary{cursor:pointer;color:var(--ring)}hr{border:0;border-top:1px solid var(--border)}
@media (max-width:720px){header.adm{padding:10px 14px;flex-wrap:wrap}header.adm nav{margin-left:0;width:100%}main{padding:16px 14px 48px}h1{font-size:20px}
table.stack,table.stack tbody,table.stack tr,table.stack td{display:block;width:auto}table.stack{border:0;background:transparent}table.stack thead{display:none}
table.stack tr{background:var(--card);border:1px solid var(--border);border-radius:12px;margin:0 0 10px;padding:6px 2px}table.stack td{border:0;padding:6px 12px}
table.stack td[data-label]::before{content:attr(data-label);display:block;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
form.settings{grid-template-columns:1fr}input,button,select,textarea{font-size:16px}}
`;

/** adm's header: the Valefront mark with the ADMIN label, and the admin pages. */
export function adminHeader(current: 'billing' | 'partners'): string {
  const link = (id: 'billing' | 'partners' | 'dashboard', href: string, label: string) => `<a href="${href}"${id === current ? ' class="on" aria-current="page"' : ''}>${label}</a>`;
  return `<header class="adm"><a class="brand" href="/"><img src="/icon.svg" alt="">Valefront <span class="pill">Admin</span></a><nav>${link('dashboard', '/', 'Dashboard')}${link('billing', '/billing/', 'Billing')}${link('partners', '/partners/', 'Partners')}</nav></header>`;
}
