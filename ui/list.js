// Exchange list: filtering, flat or thread-grouped rows, keyed row reuse and keyboard moves.
import { h, fmtTime, fmtDur, fmtTok, fmtBytes, oneLine, shortId, hashHue, put } from './dom.js';
import { KIND_LABEL, OUTCOME_LABEL, callLabel } from './labels.js';

// Same-conversation key. Falls back to the window id prefix ("<thread>:<n>") for captures without thread headers.
export const threadKey = (s) => s.thread?.thread_id ?? s.thread?.session_id ?? (s.thread?.window_id ? String(s.thread.window_id).split(':')[0] : null);
export const OUTCOME_CLASS = { active: 'info', completed: 'ok', incomplete: 'warn', failed: 'bad', error: 'bad', aborted: 'bad' };

// Imported Detail objects may lack the Summary-only fields (older or hand-made exports); derive them.
const callsOf = (s) => s.upstream_calls ?? s.upstream?.map((c) => ({ label: c.label, status: c.response?.status ?? null, end: c.response?.end ?? (c.error ? 'error' : null) })) ?? [];
const requestBytes = (s) => s.bytes?.request ?? s.client?.request?.body?.bytes ?? null;

export const isErrorish = (s) => ['failed', 'error', 'aborted', 'incomplete'].includes(s.outcome) || (s.status ?? 0) >= 400 ||
  callsOf(s).some((c) => (c.status ?? 0) >= 400 || c.end === 'error' || c.end === 'cancelled');

export const byNewest = (a, b) => (b.started_at ?? 0) - (a.started_at ?? 0) || (b.seq ?? 0) - (a.seq ?? 0);

export const FILTER_CHIPS = [
  ['errors', '仅错误', '失败、错误、中止、未完成，或任一 HTTP 状态 ≥ 400'],
  ['compaction', '仅压缩', 'kind = compaction'],
  ['active', '进行中', '仍在传输'],
  ['hideInvalid', '隐藏无效', '隐藏 kind = invalid（无法解析或路由失败）'],
];

const searchCache = new WeakMap();
function searchText(s) {
  let t = searchCache.get(s);
  if (t === undefined) {
    const th = s.thread ?? {};
    t = [s.id, s.model, s.adapter, s.api, typeof s.upstream === 'string' ? s.upstream : s.route?.upstream, s.upstream_model, s.kind, KIND_LABEL[s.kind], s.outcome, OUTCOME_LABEL[s.outcome],
      s.status, s.error, s.preview, th.session_id, th.thread_id, th.parent_thread_id, th.subagent, th.window_id,
      ...callsOf(s).flatMap((c) => [c.label, callLabel(c.label), c.status, c.end])]
      .filter((x) => x != null).join(' ').toLowerCase();
    searchCache.set(s, t);
  }
  return t;
}

export function matches(s, words, chips) {
  if (chips.errors && !isErrorish(s)) return false;
  if (chips.compaction && s.kind !== 'compaction') return false;
  if (chips.active && !s.active) return false;
  if (chips.hideInvalid && s.kind === 'invalid') return false;
  if (!words.length) return true;
  const text = searchText(s);
  return words.every((w) => text.includes(w));
}

function usageLine(u) {
  if (!u || typeof u !== 'object') return null;
  const parts = [];
  const add = (label, v) => { if (typeof v === 'number') parts.push(`${label} ${fmtTok(v)}`); };
  add('入', u.input_tokens ?? u.prompt_tokens);
  add('出', u.output_tokens ?? u.completion_tokens);
  add('缓存', u.input_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens);
  add('推理', u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens);
  return parts.length ? h('span', { class: 'x-usage', title: JSON.stringify(u, null, 1) }, parts.join(' · ')) : null;
}

const callClass = (c) => ((c.status ?? 0) >= 400 || c.end === 'error' ? 'bad' : c.end === 'active' ? 'info' : c.end === 'cancelled' ? 'warn' : c.status ? 'ok' : 'dim');

function rowEl(s, flat, onSelect) {
  const th = s.thread ?? {};
  const el = h('div', { class: `xrow o-${s.outcome}${s.active ? ' active' : ''}`, dataset: { id: s.id }, title: `${s.id} · ${s.kind}` });
  const key = threadKey(s);
  if (key) { el.classList.add('hued'); el.style.setProperty('--thue', hashHue(key)); }
  const status = s.status != null ? ` ${s.status}` : '';
  put(el,
    h('div', { class: 'x1' },
      h('span', { class: 'x-time' }, fmtTime(s.started_at)),
      h('span', { class: `chip kind k-${s.kind}` }, KIND_LABEL[s.kind] ?? s.kind ?? '?'),
      h('span', { class: 'x-model', title: s.upstream_model ? `上游模型 ${s.upstream_model}` : '' },
        s.model ?? '（无模型）', s.adapter ? h('span', { class: 'dim' }, ` → ${s.adapter}`) : null),
      h('span', { class: 'grow' }),
      h('span', { class: `chip ${OUTCOME_CLASS[s.outcome] ?? 'dim'}`, title: s.error ?? '' }, `${OUTCOME_LABEL[s.outcome] ?? s.outcome}${status}`),
      h('span', { class: 'x-dur' }, s.active ? '…' : fmtDur(s.duration_ms))),
    h('div', { class: 'x2' },
      callsOf(s).map((c) => h('span', { class: `chip sm ${callClass(c)}`, title: `end: ${c.end ?? '–'}` }, `${callLabel(c.label)} ${c.status ?? '…'}`)),
      flat && th.subagent ? h('span', { class: 'chip sm sub', title: '子代理（x-openai-subagent）' }, `子代理 ${th.subagent}`) : null,
      flat && th.parent_thread_id ? h('span', { class: 'chip sm dim', title: `父线程 ${th.parent_thread_id}` }, `父 ${shortId(th.parent_thread_id)}`) : null,
      usageLine(s.usage),
      requestBytes(s) != null ? h('span', { class: 'x-size dim', title: '客户端请求大小' }, fmtBytes(requestBytes(s))) : null),
    s.error ? h('div', { class: 'x3 err' }, oneLine(s.error, 160)) : null,
    s.preview ? h('div', { class: 'x3' }, oneLine(s.preview, 200)) : null);
  el.addEventListener('click', (e) => onSelect(s.id, e));
  return el;
}

export class ExchangeList {
  constructor(el, infoEl, { onSelect }) {
    this.el = el;
    this.infoEl = infoEl;
    this.onSelect = onSelect;
    this.rows = new Map(); // id -> {s, flat, el}
    this.order = [];
    this.collapsed = new Set();
    this.selected = null;
  }

  render(summaries, { filter, chips, group, empty }) {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const all = [...summaries.values()];
    const list = all.filter((s) => matches(s, words, chips)).sort(byNewest);
    const flat = !group;
    const rowFor = (s) => {
      let r = this.rows.get(s.id);
      if (!r || r.s !== s || r.flat !== flat) {
        r = { s, flat, el: rowEl(s, flat, this.onSelect) };
        this.rows.set(s.id, r);
      }
      r.el.classList.toggle('sel', s.id === this.selected);
      return r.el;
    };
    for (const id of this.rows.keys()) if (!summaries.has(id)) this.rows.delete(id);
    const out = [];
    this.order = [];
    if (flat) {
      for (const s of list) { out.push(rowFor(s)); this.order.push(s.id); }
    } else {
      const groups = new Map();
      for (const s of list) {
        const k = threadKey(s) ?? '';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s);
      }
      // Map thread id -> group key, to link subagent groups to their parent.
      for (const [k, items] of groups) {
        out.push(this.groupHead(k, items, groups));
        if (this.collapsed.has(k)) continue;
        for (const s of items) { out.push(rowFor(s)); this.order.push(s.id); }
      }
    }
    if (!out.length) out.push(h('div', { class: 'empty small' }, all.length ? '没有匹配筛选条件的记录' : empty));
    this.el.replaceChildren(...out);
    this.infoEl.textContent = all.length ? `显示 ${list.length} / 共 ${all.length} 条 · 最新在上` : '';
  }

  groupHead(k, items, groups) {
    const th = items.find((s) => s.thread)?.thread ?? {};
    const sub = items.find((s) => s.thread?.subagent)?.thread?.subagent;
    const parent = items.find((s) => s.thread?.parent_thread_id)?.thread?.parent_thread_id;
    const models = [...new Set(items.map((s) => s.model).filter(Boolean))];
    const collapsed = this.collapsed.has(k);
    const el = h('div', { class: 'tgroup', title: k ? `thread_id/session_id: ${k}` : '请求头里没有 thread_id / session_id' },
      h('span', { class: 'tn-tog' }, collapsed ? '▸' : '▾'),
      h('span', { class: 'swatch' }),
      h('span', { class: 'mono' }, k ? `线程 ${shortId(k, 12)}` : '（无线程信息）'),
      h('span', { class: 'dim' }, `${items.length} 条 · ${fmtTime(items[0].started_at)}`),
      models.length ? h('span', { class: 'dim' }, models.join(', ')) : null,
      sub ? h('span', { class: 'chip sm sub' }, `子代理 ${sub}`) : null,
      parent ? h('span', {
        class: 'chip sm link-chip', title: `父线程 ${parent}${groups.has(parent) ? '（点击定位）' : '（不在列表中）'}`,
        onclick: (e) => { e.stopPropagation(); const p = groups.get(parent); if (p) this.onSelect(p[0].id, e); },
      }, `↖ 父线程 ${shortId(parent, 10)}`) : null,
      th.window_id ? h('span', { class: 'dim' }, `窗口 ${shortId(th.window_id)}`) : null);
    if (k) { el.classList.add('hued'); el.style.setProperty('--thue', hashHue(k)); }
    el.addEventListener('click', () => {
      if (collapsed) this.collapsed.delete(k); else this.collapsed.add(k);
      this.rerender?.();
    });
    return el;
  }

  setSelected(id) {
    this.selected = id;
    for (const [rid, r] of this.rows) r.el.classList.toggle('sel', rid === id);
  }

  scrollToSelected() {
    this.rows.get(this.selected)?.el.scrollIntoView({ block: 'nearest' });
  }

  /** Returns the id delta rows away from the selection, in display order. */
  neighbor(delta) {
    if (!this.order.length) return null;
    const i = this.order.indexOf(this.selected);
    if (i < 0) return this.order[0];
    return this.order[Math.max(0, Math.min(this.order.length - 1, i + delta))];
  }
}
