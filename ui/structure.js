// Structure view: every top-level field in a table, and one compact row per
// item for arrays of objects (input, output, messages, system, tools, ...).
import { h, btn, fmtBytes, fmtInt, hashHue, oneLine, shortId, strBlock, strInline, thumb, isDataImage, CARRIER_RE, put } from './dom.js';
import { jsonTree, prim, preview, escPtr } from './tree.js';
import { annDetail } from './labels.js';

const ROW_PAGE = 1200;
const TEXT_KEYS = new Set(['text', 'thinking', 'content', 'output', 'arguments', 'input', 'reasoning_content', 'refusal', 'description', 'partial_json', 'instructions', 'summary']);

export const isItemArray = (v) => Array.isArray(v) && v.length > 0 &&
  v.slice(0, 20).every((x) => x && typeof x === 'object' && !Array.isArray(x));

export function newStructState() {
  return { openRows: new Set(), openFields: new Set(), openAnn: new Set(), trees: new Map(), filters: new Map(), shown: new Map() };
}

const treeState = (st, key) => {
  let t = st.trees.get(key);
  if (!t) st.trees.set(key, (t = { exp: new Set() }));
  return t;
};

/**
 * opts: { state, ann: Map<pointer, Annotation[]>, annChip(a, onClick), note }
 */
export function structureView(obj, opts) {
  const st = opts.state;
  const root = h('div', { class: 'struct' });
  if (opts.note) put(root, h('div', { class: 'note' }, opts.note));
  if (obj === null || typeof obj !== 'object') {
    put(root, h('div', { class: 'dim' }, '正文不是 JSON 对象：'), typeof obj === 'string' ? strBlock(obj) : prim(obj));
    return root;
  }
  if (Array.isArray(obj)) {
    put(root, isItemArray(obj) ? itemList('', obj, opts) : jsonTree(obj, { state: treeState(st, '#root') }));
    return root;
  }
  const lists = [];
  const tbody = h('tbody');
  for (const [key, value] of Object.entries(obj)) {
    const isList = isItemArray(value);
    if (isList) lists.push([key, value]);
    fieldRow(tbody, key, value, isList, opts);
  }
  put(root, h('table', { class: 'fields' },
    h('thead', null, h('tr', null, h('th', null, '字段'), h('th', null, '类型'), h('th', null, '值'))), tbody));
  for (const [key, value] of lists) put(root, itemList(key, value, opts));
  return root;
}

function typeText(v) {
  if (Array.isArray(v)) return `array ${v.length}`;
  if (v === null) return 'null';
  if (typeof v === 'object') return `object ${Object.keys(v).length}`;
  if (typeof v === 'string') return `string ${fmtInt(v.length)}`;
  return typeof v;
}

function fieldRow(tbody, key, value, isList, opts) {
  const st = opts.state;
  const ptr = `/${escPtr(key)}`;
  const anns = opts.ann?.get(ptr)?.map((a) => opts.annChip(a));
  const tr = h('tr', { dataset: { ptr } });
  const detail = h('tr', { class: 'field-detail' });
  let valueCell;
  let openable = false;
  let makeDetail = null;
  if (isList) {
    valueCell = h('a', { class: 'link', href: '#', onclick: (e) => { e.preventDefault(); tr.closest('.struct')?.querySelector(`[data-list="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'start' }); } },
      `${value.length} 项 · 见下方列表`);
  } else if (typeof value === 'string' && (value.length > 160 || value.includes('\n') || isDataImage(value) || CARRIER_RE.test(value))) {
    valueCell = strInline(value, 160);
    openable = true;
    makeDetail = () => strBlock(value, { name: key, tree: (v, label) => jsonTree(v, { label, auto: 2 }) });
  } else if (value && typeof value === 'object') {
    const compact = JSON.stringify(value);
    const small = compact.length <= 160;
    valueCell = small ? h('span', { class: 'mono' }, compact) : h('span', { class: 'tn-pv' }, preview(value, 140));
    openable = true;
    makeDetail = () => jsonTree(value, { state: treeState(st, ptr), base: ptr, ann: opts.ann, annChip: opts.annChip, auto: small ? 3 : 1 });
  } else {
    valueCell = prim(value);
  }
  put(tr, h('td', { class: 'fkey' }, openable ? h('span', { class: 'tn-tog' }, st.openFields.has(key) ? '▾' : '▸') : h('span', { class: 'tn-tog' }), key),
    h('td', { class: 'ftype' }, typeText(value)), h('td', { class: 'fval' }, valueCell, anns));
  put(tbody, tr);
  if (!openable) return;
  tr.classList.add('clickable');
  const td = h('td', { colSpan: 3 });
  put(detail, td);
  const show = (open) => {
    if (open) { st.openFields.add(key); if (!td.firstChild) put(td, makeDetail()); tr.after(detail); }
    else { st.openFields.delete(key); detail.remove(); }
    tr.querySelector('.tn-tog').textContent = open ? '▾' : '▸';
  };
  tr.addEventListener('click', (e) => {
    if (e.target.closest('button, a, .chip, img') || String(window.getSelection?.() ?? '')) return;
    show(!st.openFields.has(key));
  });
  if (st.openFields.has(key)) queueMicrotask(() => show(true));
}

// ---------- item lists ----------

function cacheText(cc) {
  if (!cc || typeof cc !== 'object') return 'cache';
  return `cache ${cc.ttl ?? cc.type ?? ''}`.trim();
}

function scan(v, key, depth, info) {
  if (typeof v === 'string') {
    if (key === 'encrypted_content') { info.enc += v.length; info.carrier = CARRIER_RE.exec(v)?.[1] ?? info.carrier ?? 'raw'; }
    else if (key === 'signature') info.sig += v.length;
    else if (isDataImage(v)) info.imgs.push(v);
    else if (key === 'image_url' || key === 'url') { if (/^https?:/.test(v)) info.remote++; }
    else if (TEXT_KEYS.has(key)) { info.text += v.length; if (!info.preview && v.trim()) info.preview = v; }
    return;
  }
  if (!v || typeof v !== 'object' || depth > 6) return;
  if (Array.isArray(v)) { for (const x of v) scan(x, key, depth + 1, info); return; }
  if (v.cache_control) info.cache.add(cacheText(v.cache_control));
  if (v.type === 'redacted_thinking' && typeof v.data === 'string') info.enc += v.data.length;
  if (v.type === 'base64' && typeof v.data === 'string' && /^image\//.test(v.media_type ?? '')) info.imgs.push(`data:${v.media_type};base64,${v.data}`);
  for (const [k, x] of Object.entries(v)) {
    if (k === 'cache_control') continue;
    scan(x, k, depth + 1, info);
  }
}

function partLabel(p) {
  if (!p || typeof p !== 'object') return typeof p;
  const t = p.type ?? '{…}';
  if (t === 'tool_use' || t === 'server_tool_use') return `${t}·${p.name ?? '?'}`;
  return t;
}

/** Badges and metrics for one item of any API (Responses, Messages, Chat, tools). */
export function describeItem(it) {
  const info = { text: 0, enc: 0, sig: 0, imgs: [], remote: 0, cache: new Set(), preview: '', carrier: null };
  scan(it, null, 0, info);
  const badges = [];
  const b = (text, cls, title, hue) => badges.push({ text: String(text), cls, title, hue });
  if (it.type != null) b(it.type, 'type', 'type', hashHue(String(it.type)));
  if (it.role != null) b(it.role, 'role', 'role', hashHue(`r${it.role}`));
  if (it.phase != null) b(`phase:${it.phase}`, 'phase', 'phase');
  if (it.status != null && it.status !== 'completed') b(it.status, 'dim', 'status');
  const name = it.name ?? it.function?.name;
  if (name != null) b(name, 'name', 'name');
  if (it.namespace != null) b(`ns:${it.namespace}`, 'name', 'namespace');
  for (const k of ['call_id', 'tool_call_id', 'tool_use_id']) if (typeof it[k] === 'string') b(shortId(it[k], 14), 'id', `${k}: ${it[k]}`);
  const parts = [];
  for (const key of ['content', 'output']) {
    if (!Array.isArray(it[key])) continue;
    const counts = new Map();
    for (const p of it[key]) { const l = partLabel(p); counts.set(l, (counts.get(l) ?? 0) + 1); }
    for (const [l, n] of counts) parts.push(n > 1 ? `${l}×${n}` : l);
  }
  if (parts.length) b(parts.join(' '), 'parts', '内容块类型');
  if (Array.isArray(it.summary) && it.summary.length) b(`summary×${it.summary.length}`, 'parts', 'summary');
  if (Array.isArray(it.tool_calls)) b(`tool_calls: ${it.tool_calls.map((c) => c.function?.name ?? c.name ?? '?').join(', ')}`, 'name', 'tool_calls');
  if (Array.isArray(it.tools)) b(`含 ${it.tools.length} 个工具`, 'parts', it.tools.map((t) => t.name ?? t.function?.name ?? t.type).join(', '));
  const params = it.parameters ?? it.input_schema ?? it.function?.parameters;
  if (params?.properties) b(`参数 ${Object.keys(params.properties).length}`, 'dim', Object.keys(params.properties).join(', '));
  for (const c of info.cache) b(c, 'cache', 'cache_control');
  if (info.enc) b(`${info.carrier && info.carrier !== 'raw' ? info.carrier : 'enc'} ${fmtInt(info.enc)}`, info.carrier && info.carrier !== 'raw' ? 'carrier' : 'enc', '加密/载荷长度（字符）');
  if (info.sig) b(`sig ${fmtInt(info.sig)}`, 'enc', 'signature 长度');
  if (it.reasoning_content != null && typeof it.reasoning_content === 'string') b(`reasoning_content ${fmtInt(it.reasoning_content.length)}`, 'enc', 'reasoning_content 长度');
  if (info.remote) b(`远程图片×${info.remote}`, 'dim', '未自动加载');
  return { badges, text: info.text, imgs: info.imgs, preview: info.preview };
}

function badgeEl(x) {
  const el = h('span', { class: `chip ${x.cls}`, title: x.title });
  el.textContent = x.text;
  if (x.hue != null) { el.classList.add('hue'); el.style.setProperty('--hue', x.hue); }
  return el;
}

function itemList(key, items, opts) {
  const st = opts.state;
  const base = key === '' ? '' : `/${escPtr(key)}`;
  const listAnn = new Map();
  for (const [ptr, list] of opts.ann ?? []) {
    if (!ptr.startsWith(`${base}/`)) continue;
    const idx = ptr.slice(base.length + 1).split('/')[0];
    listAnn.set(idx, [...(listAnn.get(idx) ?? []), ...list]);
  }
  let total = 0;
  const descs = items.map((it) => {
    const d = describeItem(it);
    d.size = JSON.stringify(it)?.length ?? 0;
    total += d.size;
    d.search = `${d.badges.map((x) => x.text).join(' ')} ${d.preview.slice(0, 400)}`.toLowerCase();
    return d;
  });
  const rows = h('div', { class: 'items' });
  const filter = h('input', { class: 'list-filter', type: 'search', placeholder: '筛选（类型/角色/名称/文字）', value: st.filters.get(key) ?? '' });
  const count = h('span', { class: 'dim' });
  const sec = h('section', { class: 'item-list', dataset: { list: key } },
    h('div', { class: 'list-head' },
      h('span', { class: 'list-title' }, key || '(根数组)'),
      h('span', { class: 'dim' }, `${items.length} 项 · ${fmtBytes(total)}`), count, filter,
      btn('全部收起', () => { for (const p of [...st.openRows]) if (p.startsWith(`${base}/`)) st.openRows.delete(p); render(); }),
      btn('跳到末尾', () => { st.shown.set(key, Infinity); render(); rows.lastElementChild?.scrollIntoView({ block: 'end' }); })),
    rows);

  const render = () => {
    rows.replaceChildren();
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    let matched = 0;
    const limit = st.shown.get(key) ?? ROW_PAGE;
    for (let i = 0; i < items.length; i++) {
      if (q && !descs[i].search.includes(q)) continue;
      matched++;
      if (shown >= limit) continue;
      shown++;
      put(rows, itemRow(i, items[i], descs[i], `${base}/${i}`, listAnn.get(String(i)), opts));
    }
    count.textContent = q ? `匹配 ${matched}` : '';
    if (shown < matched) put(rows, btn(`显示其余 ${fmtInt(matched - shown)} 项`, () => { st.shown.set(key, Infinity); render(); }, 'more'));
  };
  filter.addEventListener('input', () => { st.filters.set(key, filter.value); render(); });
  render();
  return sec;
}

function itemRow(i, item, d, ptr, anns, opts) {
  const st = opts.state;
  const wrap = h('div', { class: 'item', dataset: { ptr } });
  const imgs = d.imgs.slice(0, 3).map((u) => thumb(u));
  if (d.imgs.length > 3) imgs.push(h('span', { class: 'dim' }, `+${d.imgs.length - 3}`));
  const tog = h('span', { class: 'tn-tog' }, '▸');
  const row = h('div', { class: 'item-row' },
    tog, h('span', { class: 'idx' }, `#${i}`),
    h('span', { class: 'badges' }, d.badges.map(badgeEl)),
    imgs,
    h('span', { class: 'pv' }, oneLine(d.preview, 200)),
    anns?.map((a) => opts.annChip(a, () => toggleAnn())),
    h('span', { class: 'metrics', title: `文字 ${fmtInt(d.text)} 字符 · JSON ${fmtInt(d.size)} 字符` }, d.text ? `${fmtInt(d.text)} 字` : '', ` ${fmtBytes(d.size)}`));
  const body = h('div', { class: 'item-body' });
  const annBox = h('div', { class: 'item-anns' });
  put(wrap, row);
  const open = (on) => {
    if (on) {
      st.openRows.add(ptr);
      if (!body.firstChild) put(body, jsonTree(item, { state: treeState(st, ptr), base: ptr, ann: opts.ann, annChip: opts.annChip, auto: 2 }));
      put(wrap, body);
    } else {
      st.openRows.delete(ptr);
      body.remove();
    }
    tog.textContent = on ? '▾' : '▸';
    wrap.classList.toggle('open', on);
  };
  const toggleAnn = (force) => {
    const on = force ?? !st.openAnn.has(ptr);
    if (on) {
      st.openAnn.add(ptr);
      if (!annBox.firstChild) put(annBox, ...anns.map(annDetail));
      row.after(annBox);
    } else {
      st.openAnn.delete(ptr);
      annBox.remove();
    }
  };
  row.addEventListener('click', (e) => {
    if (e.target.closest('button, a, .chip, img') || String(window.getSelection?.() ?? '')) return;
    open(!st.openRows.has(ptr));
  });
  if (anns && st.openAnn.has(ptr)) toggleAnn(true);
  if (st.openRows.has(ptr)) open(true);
  return wrap;
}

/** Marks the item row for a pointer such as /input/7 as open; returns the row pointer. */
export function focusPointer(st, pointer) {
  const m = /^\/([^/]+)\/(\d+)/.exec(pointer ?? '');
  if (!m) return null;
  const row = `/${m[1]}/${m[2]}`;
  st.openRows.add(row);
  st.openAnn.add(row);
  if (Number(m[2]) >= ROW_PAGE) st.shown.set(m[1].replace(/~1/g, '/').replace(/~0/g, '~'), Infinity);
  return row;
}
