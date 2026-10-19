// Structural JSON diff: objects by key, arrays by LCS on exact item identity
// (common prefix/suffix trimmed first), replaced runs paired by type/role.
import { h, btn, copyText, fmtInt, oneLine, strBlock, put } from './dom.js';
import { jsonTree, prim, preview } from './tree.js';

const LCS_CELLS = 6e6;
const PAGE = 300;

const kindOf = (v) => (Array.isArray(v) ? 'arr' : v === null ? 'null' : typeof v === 'object' ? 'obj' : typeof v);
const sig = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? `o|${v.type ?? ''}|${v.role ?? ''}` : kindOf(v));

/** Diff node: {t:'eq'|'add'|'del'|'mod'|'obj'|'arr', ...}; n = number of changes below. */
export function diff(a, b) {
  if (a === b) return { t: 'eq', v: a, n: 0 };
  const ka = kindOf(a);
  if (ka !== kindOf(b) || (ka !== 'obj' && ka !== 'arr')) return { t: 'mod', a, b, n: 1 };
  return ka === 'obj' ? diffObj(a, b) : diffArr(a, b);
}

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffObj(a, b) {
  const entries = [];
  let n = 0;
  for (const k of Object.keys(a)) {
    if (!Object.hasOwn(b, k)) { entries.push([k, { t: 'del', v: a[k], n: 1 }]); n++; continue; }
    const d = same(a[k], b[k]) ? { t: 'eq', v: a[k], n: 0 } : diff(a[k], b[k]);
    entries.push([k, d]);
    n += d.n;
  }
  for (const k of Object.keys(b)) if (!Object.hasOwn(a, k)) { entries.push([k, { t: 'add', v: b[k], n: 1 }]); n++; }
  return { t: 'obj', entries, n };
}

function diffArr(a, b) {
  const ids = new Map();
  const id = (v) => {
    const s = typeof v === 'string' ? `s${v}` : JSON.stringify(v) ?? 'u';
    let k = ids.get(s);
    if (k === undefined) ids.set(s, (k = ids.size));
    return k;
  };
  const A = a.map(id);
  const B = b.map(id);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: 'eq', ai: i, bi: i, v: a[i] });
  const raw = lcsOps(A.slice(pre, A.length - suf), B.slice(pre, B.length - suf), pre);
  let n = 0;
  // Pair replaced runs (del... add...) by type/role so changed items show nested diffs.
  for (let k = 0; k < raw.length;) {
    if (raw[k].t === 'eq') { ops.push({ ...raw[k], v: a[raw[k].ai] }); k++; continue; }
    const dels = [];
    const adds = [];
    while (k < raw.length && raw[k].t !== 'eq') { (raw[k].t === 'del' ? dels : adds).push(raw[k]); k++; }
    let i = 0;
    let j = 0;
    while (i < dels.length || j < adds.length) {
      const da = dels[i];
      const ab = adds[j];
      if (da && ab && sig(a[da.ai]) === sig(b[ab.bi])) {
        const d = diff(a[da.ai], b[ab.bi]);
        ops.push({ t: 'chg', ai: da.ai, bi: ab.bi, d });
        n += d.n;
        i++; j++;
      } else if (ab && (!da || adds.slice(j).some((x) => sig(b[x.bi]) === sig(a[da.ai])))) {
        ops.push({ t: 'add', bi: ab.bi, v: b[ab.bi] }); n++; j++;
      } else {
        ops.push({ t: 'del', ai: da.ai, v: a[da.ai] }); n++; i++;
      }
    }
  }
  for (let i = 0; i < suf; i++) ops.push({ t: 'eq', ai: A.length - suf + i, bi: B.length - suf + i, v: a[A.length - suf + i] });
  return { t: 'arr', ops, n, la: a.length, lb: b.length };
}

function lcsOps(A, B, off) {
  const n = A.length;
  const m = B.length;
  const ops = [];
  if (!n || !m || n * m > LCS_CELLS) {
    // Too large for LCS: positional fallback keeps the view responsive.
    for (let i = 0; i < n; i++) ops.push({ t: 'del', ai: off + i });
    for (let j = 0; j < m; j++) ops.push({ t: 'add', bi: off + j });
    return ops;
  }
  const w = m + 1;
  const T = n * m < 4e6 && n < 65535 && m < 65535 ? new Uint16Array((n + 1) * w) : new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      T[i * w + j] = A[i] === B[j] ? T[(i + 1) * w + j + 1] + 1 : Math.max(T[(i + 1) * w + j], T[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: 'eq', ai: off + i, bi: off + j }); i++; j++; }
    else if (T[(i + 1) * w + j] >= T[i * w + j + 1]) { ops.push({ t: 'del', ai: off + i }); i++; }
    else { ops.push({ t: 'add', bi: off + j }); j++; }
  }
  for (; i < n; i++) ops.push({ t: 'del', ai: off + i });
  for (; j < m; j++) ops.push({ t: 'add', bi: off + j });
  return ops;
}

// ---------- rendering ----------

export function diffView(a, b, opts = {}) {
  const t0 = performance.now();
  const d = diff(a, b);
  const ms = performance.now() - t0;
  const stats = { add: 0, del: 0, mod: 0 };
  count(d, stats);
  const root = h('div', { class: 'diff' },
    h('div', { class: 'diff-stats' },
      d.n ? [h('span', { class: 'chip ok' }, `+${fmtInt(stats.add)} 新增`), h('span', { class: 'chip bad' }, `−${fmtInt(stats.del)} 删除`), h('span', { class: 'chip warn' }, `~${fmtInt(stats.mod)} 修改`)] : h('span', { class: 'chip ok' }, '完全相同'),
      h('span', { class: 'dim' }, `比较耗时 ${ms.toFixed(0)} ms`)),
    h('div', { class: 'diff-tree' }, node(opts.label ?? null, d, 0)));
  return root;
}

function count(d, s) {
  if (d.t === 'add') s.add++;
  else if (d.t === 'del') s.del++;
  else if (d.t === 'mod') s.mod++;
  else if (d.t === 'obj') for (const [, x] of d.entries) count(x, s);
  else if (d.t === 'arr') for (const op of d.ops) { if (op.t === 'add') s.add++; else if (op.t === 'del') s.del++; else if (op.t === 'chg') count(op.d, s); }
}

const keyEl = (k) => (k == null ? null : h('span', { class: typeof k === 'number' || /^[ab]\[/.test(k) ? 'tn-idx' : 'tn-key' }, String(k)));
const sepEl = (k) => (k == null ? null : h('span', { class: 'tn-sep' }, ': '));

function valueEl(v) {
  if (v && typeof v === 'object') {
    return h('span', null, h('span', { class: 'tn-sum' }, Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`), h('span', { class: 'tn-pv' }, preview(v)));
  }
  if (typeof v === 'string' && v.length > 200) return h('span', { class: 'str' }, JSON.stringify(oneLine(v, 200)).slice(0, -1) + '…"', h('span', { class: 'dim' }, ` (${fmtInt(v.length)} 字符)`));
  return prim(v);
}

/** A row whose value can be expanded into a plain JSON tree. */
function leafRow(cls, sign, k, v) {
  const wrap = h('div', { class: `dn ${cls}` });
  const tog = h('span', { class: 'tn-tog' }, v && typeof v === 'object' ? '▸' : '');
  const row = h('div', { class: 'dn-row' }, h('span', { class: 'sign' }, sign), tog, keyEl(k), sepEl(k), valueEl(v));
  put(wrap, row);
  if ((v && typeof v === 'object') || (typeof v === 'string' && v.length > 200)) {
    let body = null;
    row.classList.add('tn-click');
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (body) { body.remove(); body = null; tog.textContent = '▸'; return; }
      body = h('div', { class: 'dn-body' }, typeof v === 'string' ? strBlock(v) : jsonTree(v, { auto: 1 }));
      put(wrap, body);
      tog.textContent = '▾';
    });
  }
  return wrap;
}

function node(k, d, depth) {
  if (d.t === 'eq') return leafRow('eq', ' ', k, d.v);
  if (d.t === 'add') return leafRow('add', '+', k, d.v);
  if (d.t === 'del') return leafRow('del', '−', k, d.v);
  if (d.t === 'mod') return modRow(k, d.a, d.b);
  const wrap = h('div', { class: 'dn ch' });
  const tog = h('span', { class: 'tn-tog' }, '▾');
  const label = d.t === 'arr' ? `[${d.la} → ${d.lb}]` : '{…}';
  const row = h('div', { class: 'dn-row tn-click' }, h('span', { class: 'sign' }, '~'), tog, keyEl(k), sepEl(k),
    h('span', { class: 'tn-sum' }, label), h('span', { class: 'chip warn' }, `${fmtInt(d.n)} 处变化`));
  const kids = h('div', { class: 'tn-kids' });
  put(wrap, row, kids);
  const units = d.t === 'obj' ? d.entries.map(([key, x]) => ({ eq: x.t === 'eq', key, x })) : d.ops.map((op) => ({ eq: op.t === 'eq', op }));
  fillUnits(kids, units, d.t, depth, 0);
  row.addEventListener('click', () => {
    const open = !kids.hidden;
    kids.hidden = open;
    tog.textContent = open ? '▸' : '▾';
  });
  return wrap;
}

function unitEl(u, kind, depth) {
  if (kind === 'obj') return node(u.key, u.x, depth + 1);
  const op = u.op;
  if (op.t === 'eq') return leafRow('eq', ' ', op.ai === op.bi ? op.ai : `a[${op.ai}]→b[${op.bi}]`, op.v);
  if (op.t === 'add') return leafRow('add', '+', `b[${op.bi}]`, op.v);
  if (op.t === 'del') return leafRow('del', '−', `a[${op.ai}]`, op.v);
  return node(op.ai === op.bi ? op.ai : `a[${op.ai}]→b[${op.bi}]`, op.d, depth + 1);
}

/** Renders units, collapsing unchanged runs into a single clickable row. */
function fillUnits(box, units, kind, depth, start) {
  let rendered = 0;
  let k = start;
  while (k < units.length) {
    if (rendered >= PAGE) {
      const rest = units.length - k;
      const at = k;
      const more = btn(`显示其余 ${fmtInt(rest)} 项`, () => { more.remove(); fillUnits(box, units, kind, depth, at); }, 'more');
      put(box, more);
      return;
    }
    if (units[k].eq) {
      let e = k;
      while (e < units.length && units[e].eq) e++;
      const run = units.slice(k, e);
      if (run.length <= 2) for (const u of run) put(box, unitEl(u, kind, depth));
      else put(box, eqRun(run, kind, depth));
      rendered++;
      k = e;
      continue;
    }
    put(box, unitEl(units[k], kind, depth));
    rendered++;
    k++;
  }
}

function eqRun(run, kind, depth) {
  const label = kind === 'obj'
    ? `… ${run.length} 个键相同：${run.slice(0, 6).map((u) => u.key).join(', ')}${run.length > 6 ? ', …' : ''}`
    : `… ${run.length} 项相同（a[${run[0].op.ai}–${run[run.length - 1].op.ai}]${run[0].op.ai !== run[0].op.bi ? ` = b[${run[0].op.bi}–${run[run.length - 1].op.bi}]` : ''}）`;
  const box = h('div', { class: 'dn eqrun' });
  const row = h('div', { class: 'dn-row tn-click', title: '点击展开相同部分' }, h('span', { class: 'sign' }, ' '), h('span', { class: 'tn-tog' }, '▸'), h('span', { class: 'dim' }, label));
  put(box, row);
  row.addEventListener('click', () => {
    const kids = h('div', { class: 'tn-kids' });
    fillUnits(kids, run.map((u) => ({ ...u, eq: false })), kind, depth, 0);
    box.replaceWith(kids);
  });
  return box;
}

function modRow(k, a, b) {
  const wrap = h('div', { class: 'dn mod' });
  if (typeof a === 'string' && typeof b === 'string' && (a.length > 160 || b.length > 160 || a.includes('\n') || b.includes('\n'))) {
    put(wrap, h('div', { class: 'dn-row' }, h('span', { class: 'sign' }, '~'), h('span', { class: 'tn-tog' }), keyEl(k), sepEl(k),
      h('span', { class: 'dim' }, `字符串 ${fmtInt(a.length)} → ${fmtInt(b.length)} 字符`),
      btn('复制 A', () => copyText(a)), btn('复制 B', () => copyText(b))), strDiff(a, b));
    return wrap;
  }
  put(wrap, h('div', { class: 'dn-row' }, h('span', { class: 'sign' }, '~'), h('span', { class: 'tn-tog' }), keyEl(k), sepEl(k),
    h('span', { class: 'old' }, valueEl(a)), h('span', { class: 'arrow' }, ' → '), h('span', { class: 'new' }, valueEl(b))));
  return wrap;
}

/** Shows the changed window of two strings with shared prefix/suffix context. */
function strDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  const C = 160;
  const box = h('div', { class: 'sdiff' });
  put(box, h('div', { class: 'dim' }, `共同前缀 ${fmtInt(p)} 字符 · 共同后缀 ${fmtInt(s)} 字符`));
  const pre = h('pre', { class: 'sv-text' });
  if (p > C) put(pre, h('span', { class: 'dim' }, `…[${fmtInt(p - C)} 字符相同]…`));
  put(pre, h('span', { class: 'ctx' }, a.slice(Math.max(0, p - C), p)));
  const mid = (t, cls) => {
    const el = h('span', { class: cls });
    el.textContent = t.length > 3000 ? `${t.slice(0, 1500)} … 省略 ${fmtInt(t.length - 3000)} 字符 … ${t.slice(-1500)}` : t;
    return el;
  };
  const ma = a.slice(p, a.length - s);
  const mb = b.slice(p, b.length - s);
  if (ma) put(pre, mid(ma, 'old'));
  if (mb) put(pre, mid(mb, 'new'));
  put(pre, h('span', { class: 'ctx' }, a.slice(a.length - s, a.length - s + C)));
  if (s > C) put(pre, h('span', { class: 'dim' }, `…[${fmtInt(s - C)} 字符相同]…`));
  put(box, pre);
  return box;
}
