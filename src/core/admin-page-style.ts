/**
 * adm's server pages (Billing, Partners) in the same frame and look as the adm React app (dashboard/): AppShell's
 * sidebar with adm's pages, and the app's tokens, font, cards, tables, buttons, inputs and badges, light and dark
 * (the app's own stored choice, valefront.theme). Styling only: the pages' forms and actions are unchanged.
 *
 * The colour tokens are dashboard/src/styles.css's, value for value (tests/admin-page-style.test.ts fails if they
 * drift); the icons are lucide's (the app's icon set, ISC), as SVG.
 */

/** dashboard/src/styles.css :root. */
export const LIGHT_TOKENS: Record<string, string> = {
  'radius': '0.625rem',
  'background': 'oklch(0.99 0.003 250)',
  'foreground': 'oklch(0.141 0.005 285.823)',
  'card': 'oklch(1 0 0)',
  'card-foreground': 'oklch(0.141 0.005 285.823)',
  'popover': 'oklch(1 0 0)',
  'popover-foreground': 'oklch(0.141 0.005 285.823)',
  'primary': 'oklch(0.52 0.12 162)',
  'primary-foreground': 'oklch(0.99 0.01 162)',
  'secondary': 'oklch(0.967 0.001 286.375)',
  'secondary-foreground': 'oklch(0.21 0.006 285.885)',
  'muted': 'oklch(0.967 0.001 286.375)',
  'muted-foreground': 'oklch(0.552 0.016 285.938)',
  'accent': 'oklch(0.955 0.03 162)',
  'accent-foreground': 'oklch(0.32 0.08 162)',
  'destructive': 'oklch(0.577 0.245 27.325)',
  'border': 'oklch(0.92 0.004 286.32)',
  'input': 'oklch(0.92 0.004 286.32)',
  'ring': 'oklch(0.68 0.13 255)',
  'success': 'oklch(0.6 0.15 150)',
  'warning': 'oklch(0.7 0.15 70)',
  'sidebar': 'oklch(0.985 0.006 162)',
};
/** dashboard/src/styles.css .dark. */
export const DARK_TOKENS: Record<string, string> = {
  'background': 'oklch(0.16 0.014 255)',
  'foreground': 'oklch(0.985 0 0)',
  'card': 'oklch(0.2 0.016 255)',
  'card-foreground': 'oklch(0.985 0 0)',
  'popover': 'oklch(0.2 0.016 255)',
  'popover-foreground': 'oklch(0.985 0 0)',
  'primary': 'oklch(0.9 0.1 162)',
  'primary-foreground': 'oklch(0.26 0.06 162)',
  'secondary': 'oklch(0.25 0.016 255)',
  'secondary-foreground': 'oklch(0.985 0 0)',
  'muted': 'oklch(0.25 0.016 255)',
  'muted-foreground': 'oklch(0.705 0.015 286.067)',
  'accent': 'oklch(0.3 0.04 170)',
  'accent-foreground': 'oklch(0.95 0.06 162)',
  'destructive': 'oklch(0.704 0.191 22.216)',
  'border': 'oklch(1 0 0 / 10%)',
  'input': 'oklch(1 0 0 / 15%)',
  'ring': 'oklch(0.72 0.13 255)',
  'success': 'oklch(0.72 0.15 150)',
  'warning': 'oklch(0.8 0.14 75)',
  'sidebar': 'oklch(0.14 0.014 255)',
};

const ICONS: Record<string, string> = {
  'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  'flask-conical': '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
  'server': '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  'route': '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  'key-round': '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  'layers': '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
  'wallet': '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  'credit-card': '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/><path d="M6 14h2"/>',
  'badge-percent': '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m15 9-6 6"/><path d="M9 9h.01"/><path d="M15 15h.01"/>',
  'handshake': '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>',
  'calculator': '<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>',
  'activity': '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'moon': '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
  'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  'log-out': '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
};

const icon = (name: string, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
const vars = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';');
const mix = (v: string, pct: number) => `color-mix(in oklch,var(--${v}) ${pct}%,transparent)`;

export const ADMIN_PAGE_CSS = `:root{${vars(LIGHT_TOKENS)};color-scheme:light}.dark{${vars(DARK_TOKENS)};color-scheme:dark}
*,*::before,*::after{box-sizing:border-box;border-color:var(--border)}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--background);color:var(--foreground);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
svg.i{width:16px;height:16px;flex-shrink:0}
.shell{min-height:100svh}
@media (min-width:768px){.shell{display:grid;grid-template-columns:16rem minmax(0,1fr)}}
aside.side{position:sticky;top:0;z-index:20;border-bottom:1px solid var(--border);background:${mix('sidebar', 95)};-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
@media (min-width:768px){aside.side{display:flex;flex-direction:column;height:100svh;border-bottom:0;border-right:1px solid var(--border)}}
.top{display:flex;align-items:center;gap:8px;padding:12px 16px}@media (min-width:768px){.top{padding:24px 20px}}
.brand{display:flex;align-items:center;gap:10px;min-width:0;color:inherit;text-decoration:none}.brand img{width:32px;height:32px;flex-shrink:0}
.brand b{display:block;font-weight:600;letter-spacing:-.025em;line-height:1.25}
.pill{display:inline-block;border-radius:999px;background:${mix('primary', 15)};padding:1px 6px;font-size:10px;font-weight:600;letter-spacing:.025em;text-transform:uppercase;color:var(--primary);line-height:1.5}
.top .tools{margin-left:auto;display:flex}@media (min-width:768px){.top .tools{display:none}}
.ghost{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;min-width:36px;padding:0 8px;border:0;border-radius:calc(var(--radius) - 2px);background:transparent;color:var(--foreground);font:inherit;font-size:14px;font-weight:500;text-decoration:none;cursor:pointer}
.ghost:hover{background:var(--accent);color:var(--accent-foreground);text-decoration:none}
.dark .i-moon,html:not(.dark) .i-sun{display:none}
nav.flat{display:flex;gap:4px;overflow-x:auto;padding:0 8px 8px;scrollbar-width:none}nav.flat::-webkit-scrollbar{display:none}
nav.flat a{display:flex;flex-shrink:0;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:6px 12px;color:var(--muted-foreground);text-decoration:none;white-space:nowrap}
nav.flat a[aria-current]{border-color:transparent;background:var(--accent);color:var(--accent-foreground);font-weight:500}
nav.desk{display:none}
@media (min-width:768px){nav.flat{display:none}nav.desk{display:flex;flex-direction:column;gap:4px;padding:0 8px;overflow-y:auto}}
nav.desk a,nav.desk summary{display:flex;align-items:center;gap:8px;border-radius:calc(var(--radius) - 2px);padding:8px 12px;color:var(--muted-foreground);text-decoration:none;cursor:pointer;transition:background-color .15s,color .15s}
nav.desk a:hover,nav.desk summary:hover{background:var(--accent);text-decoration:none}
nav.desk a[aria-current]{background:var(--accent);color:var(--accent-foreground);font-weight:500}
nav.desk details{display:flex;flex-direction:column;gap:4px}nav.desk details>div{display:flex;flex-direction:column;gap:4px;margin-top:4px}
nav.desk summary{list-style:none}nav.desk summary::-webkit-details-marker{display:none}nav.desk details.active summary{color:var(--foreground);font-weight:500}
nav.desk summary .chev{margin-left:auto;transition:transform .15s}nav.desk details[open] summary .chev{transform:rotate(180deg)}
nav.desk details a{padding-left:32px}
.foot{display:none}@media (min-width:768px){.foot{display:block;margin-top:auto;border-top:1px solid var(--border);padding:12px}}
.foot .who{margin:0 0 8px;padding:0 4px;font-size:12px;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.foot .row{display:flex;align-items:center;gap:4px}.foot .row .out{margin-left:auto;height:32px;padding:0 12px}
main{min-width:0;padding:24px 16px}@media (min-width:768px){main{padding:40px}}
.page{max-width:72rem;margin:0 auto}
h1{margin:0;font-size:24px;line-height:1.33;font-weight:600;letter-spacing:-.025em}
h1+p{margin:4px 0 24px;max-width:48rem}
h2{margin:36px 0 12px;font-size:16px;line-height:1.25;font-weight:600;letter-spacing:-.01em}
p{margin:8px 0;color:var(--muted-foreground);overflow-wrap:break-word}p strong{color:var(--foreground);font-weight:600}
small{font-size:12px;color:var(--muted-foreground)}
a{color:var(--primary);text-decoration:none;text-underline-offset:4px}a:hover{text-decoration:underline}
a[href^="mailto:"]{white-space:nowrap}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--muted);border-radius:4px;padding:1px 5px;white-space:nowrap}
hr{border:0;border-top:1px solid var(--border);margin:8px 0}
.wrap{overflow-x:auto;border:1px solid var(--border);border-radius:calc(var(--radius) + 4px);background:var(--card);color:var(--card-foreground);box-shadow:0 1px 3px 0 rgb(0 0 0 / .1),0 1px 2px -1px rgb(0 0 0 / .1);-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px}
th{height:40px;padding:0 12px;text-align:left;vertical-align:middle;font-weight:500;color:var(--foreground);white-space:nowrap;border-bottom:1px solid var(--border)}
td{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--border);min-width:7rem}
tbody tr:last-child td{border-bottom:0}tbody tr{transition:background-color .15s}tbody tr:hover{background:${mix('muted', 50)}}
.n{text-align:right;white-space:nowrap}
input,textarea,select{font:inherit;font-size:14px;color:var(--foreground);background:transparent;height:36px;min-width:0;max-width:100%;padding:4px 12px;border:1px solid var(--input);border-radius:calc(var(--radius) - 2px);box-shadow:0 1px 2px 0 rgb(0 0 0 / .05);outline:none;transition:border-color .15s,box-shadow .15s}
.dark input,.dark textarea,.dark select{background:${mix('input', 30)}}
select{padding-right:8px}select option{background:var(--popover);color:var(--popover-foreground)}
textarea{height:auto;min-height:64px;padding:8px 12px;resize:vertical}
input::placeholder,textarea::placeholder{color:var(--muted-foreground)}
input:focus-visible,textarea:focus-visible,select:focus-visible{border-color:var(--ring);box-shadow:0 0 0 3px ${mix('ring', 50)}}
input[type=file]{height:auto;padding:6px 8px}input[type=file]::file-selector-button{font:inherit;font-size:13px;font-weight:500;color:var(--foreground);background:transparent;border:0;margin-right:8px;cursor:pointer}
button{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 16px;margin:0;border:0;border-radius:calc(var(--radius) - 2px);background:var(--primary);color:var(--primary-foreground);font:inherit;font-size:14px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s}
button:hover{background:${mix('primary', 90)}}button:focus-visible{outline:none;box-shadow:0 0 0 3px ${mix('ring', 50)}}
td button{height:32px;padding:0 12px}
button.ghost{background:transparent;color:var(--foreground)}button.ghost:hover{background:var(--accent)}
td form{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;margin:0 0 8px}td form:last-child{margin-bottom:0}
td form label{flex:1 1 9rem}td form input:not([type=hidden]){flex:1 1 7rem}td label input{width:100%}
form{margin:0}form[style*="margin:8px 0"]{margin:12px 0 !important}
form.settings{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:16px;align-items:end;padding:24px;border:1px solid var(--border);border-radius:calc(var(--radius) + 4px);background:var(--card);box-shadow:0 1px 3px 0 rgb(0 0 0 / .1),0 1px 2px -1px rgb(0 0 0 / .1);margin:12px 0}
form.settings label:has(textarea){grid-column:1/-1}
label{display:flex;flex-direction:column;gap:8px;font-size:14px;font-weight:500;line-height:1;color:var(--foreground)}label input,label textarea,label select{width:100%;font-weight:400;line-height:1.5}
.note{margin:16px 0;padding:12px 16px;border:1px solid ${mix('warning', 40)};border-radius:var(--radius);background:${mix('warning', 10)};color:var(--foreground)}
details{margin-top:6px}summary{cursor:pointer;color:var(--primary);font-weight:500}details[open]>summary{margin-bottom:8px}
.badge{display:inline-flex;align-items:center;width:fit-content;border:1px solid transparent;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:500;line-height:1.33;white-space:nowrap;vertical-align:middle}
.badge.ok{background:${mix('success', 15)};color:var(--success)}.badge.bad{background:${mix('destructive', 12)};color:var(--destructive)}
.badge.warn{background:${mix('warning', 18)};color:var(--foreground)}.badge.live{background:var(--primary);color:var(--primary-foreground)}
.warn-text{white-space:pre-wrap;color:var(--warning)}
nav.filters{display:flex;flex-wrap:wrap;gap:4px;width:fit-content;max-width:100%;margin:8px 0 12px;padding:3px;border-radius:var(--radius);background:var(--muted)}
nav.filters a{padding:4px 12px;border-radius:calc(var(--radius) - 2px);color:var(--muted-foreground);font-weight:500;white-space:nowrap}nav.filters a:hover{color:var(--foreground);text-decoration:none}
nav.filters a[aria-current]{background:var(--background);color:var(--foreground);box-shadow:0 1px 2px 0 rgb(0 0 0 / .05)}
@media (max-width:767px){h1{font-size:20px}input,textarea,select{font-size:16px}}
`;

type Current = 'customer-billing' | 'partner-inquiries';
type Item = { id: string; label: string; icon: string; href: string };
/** adm's navigation, as dashboard/src/app.tsx builds it for the hosted owner (navFor(true)), with page paths. */
const PAGE = (id: string, label: string, icon: string): Item => ({ id, label, icon, href: `/${id}` });
const TOP: Item[] = [PAGE('overview', 'Overview', 'layout-dashboard'), PAGE('benchmarks', 'Benchmarks', 'flask-conical'), PAGE('providers', 'Providers', 'server'), PAGE('routing', 'Routing', 'route'), PAGE('keys', 'Access keys', 'key-round'), PAGE('offered', 'Offered models', 'layers')];
const BILLING: Item[] = [PAGE('spending', 'Spending', 'wallet'), { id: 'customer-billing', label: 'Customer billing', icon: 'credit-card', href: '/billing/' }, PAGE('campaigns', 'Campaigns', 'badge-percent'), { id: 'partner-inquiries', label: 'Partner inquiries', icon: 'handshake', href: '/partners/' }, PAGE('calculator', 'Cost calculator', 'calculator')];
const AFTER: Item[] = [PAGE('playground', 'Playground', 'flask-conical'), PAGE('activity', 'Activity', 'activity')];
/** Every page in adm's nav, for tests (dashboard/src/app.tsx's NAV and BILLING ids). */
export const ADMIN_NAV_IDS = [...TOP, ...BILLING, ...AFTER].map((i) => i.id);

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const link = (i: Item, current: Current) => `<a href="${i.href}"${i.id === current ? ' aria-current="page"' : ''}>${icon(i.icon)}${i.label}</a>`;

/** Sets the app's light/dark choice before the page paints (dashboard/src/app.tsx useTheme, same storage key). */
const THEME_SCRIPT = `<script>(function(){var s=null;try{s=localStorage.getItem('valefront.theme')}catch(e){}document.documentElement.classList.toggle('dark',s?s==='dark':matchMedia('(prefers-color-scheme: dark)').matches)})();function vfTheme(){var d=!document.documentElement.classList.contains('dark');document.documentElement.classList.toggle('dark',d);try{localStorage.setItem('valefront.theme',d?'dark':'light')}catch(e){}}</script>`;

/**
 * A whole adm server page: adm's sidebar (phones: header and one row of page tabs), and the page's own HTML in the
 * app's content column. `who` is the Access admin (shown with sign-out, as in the app).
 */
export function adminDocument(p: { current: Current; title: string; who: string; body: string; css?: string }): string {
  const theme = `<button type="button" class="ghost" onclick="vfTheme()" aria-label="Toggle theme">${icon('moon', 'i-moon')}${icon('sun', 'i-sun')}</button>`;
  const signOut = p.who.startsWith('service:') ? '' : `<a class="ghost out" href="/cdn-cgi/access/logout">${icon('log-out')}Sign out</a>`;
  const signOutIcon = p.who.startsWith('service:') ? '' : `<a class="ghost" href="/cdn-cgi/access/logout" aria-label="Sign out">${icon('log-out')}</a>`;
  const inBilling = BILLING.some((i) => i.id === p.current);
  const desk = `<nav class="desk" aria-label="Pages">${TOP.map((i) => link(i, p.current)).join('')}<details${inBilling ? ' open class="active"' : ''}><summary>${icon('wallet')}Billing${icon('chevron-down', 'chev')}</summary><div>${BILLING.map((i) => link(i, p.current)).join('')}</div></details>${AFTER.map((i) => link(i, p.current)).join('')}</nav>`;
  const flat = `<nav class="flat" aria-label="Pages">${[...TOP, ...BILLING, ...AFTER].map((i) => link(i, p.current)).join('')}</nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(p.title)} · Valefront Admin</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">${THEME_SCRIPT}<style>${ADMIN_PAGE_CSS}${p.css ?? ''}</style></head><body><div class="shell">
<aside class="side"><div class="top"><a class="brand" href="/"><img src="/icon.svg" alt=""><span><b>Valefront</b><span class="pill">Admin</span></span></a><div class="tools">${theme}${signOutIcon}</div></div>
${flat}${desk}<div class="foot"><div class="who" title="${esc(p.who)}">${esc(p.who)}</div><div class="row">${theme}${signOut}</div></div></aside>
<main><div class="page">
${p.body}
</div></main></div><script>document.querySelector('nav.flat [aria-current]')?.scrollIntoView({block:'nearest',inline:'center'})</script></body></html>`;
}

/** A row of filter tabs (All · Pending · …), the current one marked. */
export function filterTabs(items: { href: string; label: string; current: boolean }[]): string {
  return `<nav class="filters">${items.map((i) => `<a href="${i.href}"${i.current ? ' aria-current="page"' : ''}>${i.label}</a>`).join('')}</nav>`;
}

/** yes / no as a badge. */
export const yesNo = (b: boolean) => (b ? '<span class="badge ok">yes</span>' : '<span class="badge bad">no</span>');
/** A payment's or invoice's mode as a badge. */
export const modeBadge = (mode: string) => (mode === 'live' ? '<span class="badge live">LIVE</span>' : '<span class="badge warn">SANDBOX</span>');
