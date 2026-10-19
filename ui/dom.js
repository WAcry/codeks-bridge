// Shared DOM, formatting and value-rendering helpers for the inspector UI.
// All captured content is untrusted: build nodes with createElement/textContent only.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (typeof v !== 'string' && k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}

/** Appends kids to el, skipping null/false and flattening arrays like h(). */
export function put(el, ...kids) { add(el, kids); return el; }

/** Replaces the children of el, skipping null/false and flattening arrays like h(). */
export function fill(el, ...kids) {
  el.replaceChildren();
  add(el, kids);
  return el;
}

export const btn = (label, onclick, cls = '', title) =>
  h('button', { type: 'button', class: `btn ${cls}`.trim(), title, onclick: (e) => { e.stopPropagation(); onclick(e); } }, label);

// ---------- formatting ----------

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function fmtTime(ms) {
  if (ms == null) return '–';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function fmtDateTime(ms) {
  if (ms == null) return '–';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtTime(ms)}`;
}

export function fmtDur(ms) {
  if (ms == null) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60000);
  return `${m}m${pad(Math.round((ms % 60000) / 1000))}s`;
}

export function fmtOffset(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `+${Math.round(ms)}ms` : `+${(ms / 1000).toFixed(2)}s`;
}

export function fmtBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export const fmtInt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));

export function fmtTok(n) {
  if (n == null) return '–';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function oneLine(s, max = 160) {
  if (typeof s !== 'string') return '';
  const t = s.slice(0, max * 3).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export const shortId = (s, n = 8) => (typeof s === 'string' && s.length > n + 2 ? `${s.slice(0, n)}…` : s);

export function hashHue(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return (x >>> 0) % 360;
}

export function tryJson(text) {
  if (typeof text !== 'string') return { ok: false };
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ---------- clipboard / download / toast ----------

let toastTimer;
export function toast(msg, isError = false) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast' }); document.body.append(el); }
  el.textContent = msg;
  el.className = `toast show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, isError ? 5000 : 1800);
}

export async function copyText(text) {
  text = String(text);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', top: '0', left: '0', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`已复制 ${fmtInt(text.length)} 字符`);
}

export function download(name, data, type = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const safeName = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 80);

// ---------- bridge carriers and data URLs ----------

function b64ToBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const CARRIER_RE = /^(cxbr2|cxbc1):/;

/** Decodes a bridge state envelope: prefix + base64url(JSON). */
export function decodeCarrier(s) {
  const m = CARRIER_RE.exec(s);
  if (!m) return null;
  try {
    return { prefix: m[1], value: JSON.parse(new TextDecoder().decode(b64ToBytes(s.slice(m[0].length)))) };
  } catch (e) {
    return { prefix: m[1], error: String(e.message || e) };
  }
}

const DATA_IMG_RE = /^data:(image\/[a-z0-9.+-]+);base64,/i;
export const isDataImage = (s) => typeof s === 'string' && DATA_IMG_RE.test(s.slice(0, 64));

export function dataUrlBlob(url) {
  const m = /^data:([^;,]*)(;base64)?,/i.exec(url.slice(0, 200));
  if (!m) return new Blob([url], { type: 'text/plain' });
  const body = url.slice(m[0].length);
  return new Blob([m[2] ? b64ToBytes(body) : decodeURIComponent(body)], { type: m[1] || 'application/octet-stream' });
}

/** Small image thumbnail; data: URLs only, remote URLs are shown as text. */
export function thumb(url, size = 'sm') {
  if (!isDataImage(url)) return h('span', { class: 'chip dim', title: url }, '远程图片');
  const img = h('img', { class: `thumb ${size}`, src: url, alt: 'image', title: '点击放大' });
  img.addEventListener('click', (e) => { e.stopPropagation(); img.classList.toggle('big'); });
  return img;
}

// ---------- string rendering ----------

const FOLD = 3000, HEAD = 1500, TAIL = 1500;

/**
 * A block view for a string: shows head + omitted marker + tail for long text,
 * with buttons to expand, copy, download, decode carriers and parse JSON.
 */
export function strBlock(s, opts = {}) {
  const name = opts.name || 'text';
  const box = h('div', { class: 'sv' });
  if (isDataImage(s)) {
    const mime = DATA_IMG_RE.exec(s.slice(0, 64))[1];
    put(box, h('div', { class: 'sv-tools' },
      thumb(s, 'md'),
      h('span', { class: 'dim' }, `${mime} · ${fmtBytes(s.length)}（data URL）`),
      btn('复制', () => copyText(s)),
      btn('下载图片', () => download(`${name}.${mime.split('/')[1].replace(/\W.*/, '')}`, dataUrlBlob(s)))));
    return box;
  }
  const pre = h('pre', { class: 'sv-text' });
  const extra = h('div', { class: 'sv-extra' });
  let full = false;
  let foldBtn = null;
  const render = () => {
    if (foldBtn) foldBtn.textContent = full ? '折叠' : '展开全部';
    pre.replaceChildren();
    if (full || s.length <= FOLD) put(pre, s);
    else {
      put(pre, s.slice(0, HEAD),
        h('span', { class: 'sv-omit', title: '点击展开全部', onclick: (e) => { e.stopPropagation(); full = true; render(); } },
          ` … 省略 ${fmtInt(s.length - HEAD - TAIL)} 字符 … `),
        s.slice(-TAIL));
    }
  };
  render();
  const tools = h('div', { class: 'sv-tools' }, h('span', { class: 'dim' }, `${fmtInt(s.length)} 字符`));
  if (s.length > FOLD) put(tools, foldBtn = btn('展开全部', () => { full = !full; render(); }));
  put(tools, btn('复制', () => copyText(s)), btn('下载', () => download(`${name}.txt`, s, 'text/plain')));
  if (CARRIER_RE.test(s) && opts.tree) {
    put(tools, btn('解码载荷', () => toggleExtra(extra, () => {
      const d = decodeCarrier(s);
      return d.error ? h('div', { class: 'err' }, `解码失败：${d.error}`) : opts.tree(d.value, `${d.prefix} 解码`);
    })));
  } else if (opts.tree && /^\s*[[{]/.test(s.slice(0, 20))) {
    put(tools, btn('按 JSON 解析', () => toggleExtra(extra, () => {
      const r = tryJson(s);
      return r.ok ? opts.tree(r.value, 'JSON') : h('div', { class: 'err' }, `不是合法 JSON：${r.error}`);
    })));
  }
  put(box, tools, pre, extra);
  return box;
}

function toggleExtra(extra, make) {
  if (extra.firstChild) extra.replaceChildren();
  else put(extra, make());
}

/** Inline string preview used in compact rows and tables. */
export function strInline(s, max = 120) {
  if (isDataImage(s)) return h('span', { class: 'str' }, thumb(s), ` data URL ${fmtBytes(s.length)}`);
  if (s.length <= max && !s.includes('\n')) return h('span', { class: 'str' }, JSON.stringify(s));
  return h('span', { class: 'str' }, JSON.stringify(oneLine(s, max)).slice(0, -1) + '…"', h('span', { class: 'dim' }, ` (${fmtInt(s.length)} 字符)`));
}

/** Simple key/value table; values may be nodes or strings. */
export function kvTable(rows, cls = '') {
  return h('table', { class: `kv ${cls}`.trim() },
    h('tbody', null, rows.map(([k, v, title]) => h('tr', null, h('th', { title }, k), h('td', null, v)))));
}
