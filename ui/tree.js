// Lazy JSON tree: children are created only when a node is expanded.
import { h, btn, copyText, download, fmtInt, strBlock, isDataImage, thumb, CARRIER_RE, toast, put } from './dom.js';

const PAGE = 300;
const EXPAND_BUDGET = 4000;

export const escPtr = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * opts.state: { exp: Set<string> } keeps expanded paths across re-renders.
 * opts.ann: Map<pointer, Annotation[]>, opts.annChip(ann) -> Node.
 * opts.label: optional root label. opts.base: pointer prefix of the root.
 */
export function jsonTree(value, opts = {}) {
  const state = opts.state || { exp: new Set() };
  const base = opts.base || '';
  if (!state.init) { state.init = true; state.exp.add(base); if (opts.auto) autoExpand(value, base, state.exp, opts.auto); }
  const ctx = {
    exp: state.exp,
    ann: opts.ann,
    annChip: opts.annChip,
    subtree: (v, label) => jsonTree(v, { label, auto: 2, annChip: opts.annChip }),
  };
  return h('div', { class: 'tree' }, nodeEl(opts.label ?? null, value, base, ctx));
}

/** Expands small containers near the root (used for item rows). */
function autoExpand(v, path, set, depth) {
  if (!v || typeof v !== 'object' || depth <= 0) return;
  const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
  if (keys.length > 40) return;
  set.add(path);
  for (const k of keys) autoExpand(v[k], `${path}/${escPtr(k)}`, set, depth - 1);
}

function expandAll(v, path, set, budget) {
  if (!v || typeof v !== 'object') return;
  if (budget.n-- <= 0) { budget.hit = true; return; }
  set.add(path);
  const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
  for (const k of keys.slice(0, PAGE)) {
    if (budget.n <= 0) { budget.hit = true; break; }
    expandAll(v[k], `${path}/${escPtr(k)}`, set, budget);
  }
}

function collapseAll(path, set) {
  for (const p of [...set]) if (p === path || p.startsWith(`${path}/`)) set.delete(p);
}

export function preview(v, max = 90) {
  let out = '';
  if (Array.isArray(v)) {
    const parts = [];
    for (const x of v.slice(0, 6)) {
      if (x && typeof x === 'object' && !Array.isArray(x)) parts.push(x.type ?? x.role ?? '{…}');
      else parts.push(short(x));
    }
    out = parts.join(', ') + (v.length > 6 ? ', …' : '');
  } else if (v && typeof v === 'object') {
    const parts = [];
    for (const [k, x] of Object.entries(v).slice(0, 5)) parts.push(`${k}: ${short(x)}`);
    out = parts.join(', ') + (Object.keys(v).length > 5 ? ', …' : '');
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

function short(x) {
  if (Array.isArray(x)) return `[${x.length}]`;
  if (x && typeof x === 'object') return '{…}';
  if (typeof x === 'string') return JSON.stringify(x.length > 30 ? `${x.slice(0, 30)}…` : x);
  return String(x);
}

export function prim(v) {
  if (typeof v === 'string') return h('span', { class: 'str' }, JSON.stringify(v));
  if (typeof v === 'number') return h('span', { class: 'num' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: 'bool' }, String(v));
  if (v === undefined) return h('span', { class: 'null' }, 'undefined');
  return h('span', { class: 'null' }, 'null');
}

const longString = (v) => typeof v === 'string' && (v.length > 120 || v.includes('\n') || isDataImage(v) || CARRIER_RE.test(v));

function nodeEl(key, value, path, ctx) {
  const wrap = h('div', { class: 'tn' });
  const row = h('div', { class: 'tn-row' });
  put(wrap, row);
  const keyEl = key == null ? null : h('span', { class: typeof key === 'number' ? 'tn-idx' : 'tn-key' }, String(key));
  const sep = keyEl ? h('span', { class: 'tn-sep' }, ': ') : null;
  const anns = ctx.ann?.get(path);
  const annEls = anns && ctx.annChip ? anns.map((a) => ctx.annChip(a)) : null;
  const tog = h('span', { class: 'tn-tog' });

  if (value === null || typeof value !== 'object') {
    if (longString(value)) {
      const label = isDataImage(value) ? [thumb(value), ` 图片 data URL`] : CARRIER_RE.test(value) ? `bridge 载荷 ${value.slice(0, 5)}` : '字符串';
      put(row, tog, keyEl, sep, h('span', { class: 'dim' }, label, ` · ${fmtInt(value.length)} 字符`), annEls);
      put(wrap, h('div', { class: 'tn-str' }, strBlock(value, { name: key ?? 'value', tree: ctx.subtree })));
    } else {
      put(row, tog, keyEl, sep, prim(value), annEls);
    }
    return wrap;
  }

  const isArr = Array.isArray(value);
  const keys = isArr ? null : Object.keys(value);
  const n = isArr ? value.length : keys.length;
  const sum = h('span', { class: 'tn-sum' }, isArr ? `[${n}]` : `{${n}}`);
  const pv = h('span', { class: 'tn-pv' }, preview(value));
  const acts = h('span', { class: 'tn-acts' },
    btn('复制', () => copyText(JSON.stringify(value, null, 2))),
    n ? btn('全部展开', () => {
      const budget = { n: EXPAND_BUDGET };
      expandAll(value, path, ctx.exp, budget);
      if (budget.hit) toast(`节点过多，只展开了前 ${fmtInt(EXPAND_BUDGET)} 个`);
      wrap.replaceWith(nodeEl(key, value, path, ctx));
    }) : null,
    n ? btn('收起', () => { collapseAll(path, ctx.exp); wrap.replaceWith(nodeEl(key, value, path, ctx)); }) : null,
    key == null ? btn('下载', () => download('value.json', JSON.stringify(value, null, 2))) : null);
  put(row, tog, keyEl, sep, sum, pv, annEls, acts);
  if (!n) return wrap;

  let kids = null;
  const setOpen = (open) => {
    if (open) {
      ctx.exp.add(path);
      if (!kids) { kids = h('div', { class: 'tn-kids' }); fill(kids, value, keys, path, ctx, 0); }
      put(wrap, kids);
    } else {
      ctx.exp.delete(path);
      kids?.remove();
    }
    tog.textContent = open ? '▾' : '▸';
    pv.hidden = open;
  };
  row.classList.add('tn-click');
  row.addEventListener('click', (e) => {
    if (e.target.closest('button, .chip, a, img')) return;
    if (String(window.getSelection?.() ?? '')) return;
    setOpen(!ctx.exp.has(path));
  });
  setOpen(ctx.exp.has(path));
  return wrap;
}

function fill(kids, value, keys, path, ctx, start) {
  const n = keys ? keys.length : value.length;
  const end = Math.min(n, start + PAGE);
  for (let i = start; i < end; i++) {
    const k = keys ? keys[i] : i;
    put(kids, nodeEl(k, value[k], `${path}/${escPtr(k)}`, ctx));
  }
  if (end < n) {
    const more = btn(`显示更多（还有 ${fmtInt(n - end)} 项）`, () => { more.remove(); fill(kids, value, keys, path, ctx, end); }, 'more');
    put(kids, more);
  }
}
