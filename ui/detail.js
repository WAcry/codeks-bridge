// Detail of one exchange: header, the four-stage pipeline, and up to two panes
// (overview, a stage body in one of several view modes, annotations, diff).
import { h, btn, fill, copyText, download, fmtBytes, fmtDateTime, fmtDur, fmtInt, fmtTime, kvTable, oneLine, safeName, shortId, strBlock, toast, tryJson, put } from './dom.js';
import { jsonTree } from './tree.js';
import { structureView, newStructState, focusPointer } from './structure.js';
import { eventsView, newEventsState, finalObject, inputTransformationReports, parseEvents, usageText } from './events.js';
import { diffView } from './diff.js';
import { annChip, annDetail, annIndex, callLabel, decisionClass, decisionText, END_LABEL, INPUT_TRANSFORMATION_LABEL, KIND_LABEL, KIND_TEXT, OUTCOME_LABEL, reasonText, sourceText } from './labels.js';
import { threadKey, byNewest } from './list.js';
import { exchangeClass, responseClass as respClass, responseFailure } from './status.js';
import { exportDoc } from './api.js';
import { responseLatency } from './latency.js';

const RAW_LIMIT = 200_000;
const VIEW_STATES = 80;
const REQUEST_MODES = [['struct', '结构'], ['json', 'JSON'], ['raw', '原始'], ['headers', '头部']];
const RESPONSE_MODES = [['struct', '结构'], ['events', '事件'], ['json', 'JSON'], ['raw', '原始'], ['headers', '头部']];

// ---------- stage model ----------

/** Stable key per upstream call: its label, numbered when a label repeats. */
function callKeys(calls) {
  const seen = new Map();
  return (calls ?? []).map((c) => {
    const n = (seen.get(c.label) ?? 0) + 1;
    seen.set(c.label, n);
    return n > 1 ? `${c.label}#${n}` : String(c.label);
  });
}

/** All panes of an exchange, in pipeline order. */
export function stagesOf(d) {
  const keys = callKeys(d.upstream);
  const out = [{ key: 'overview', type: 'overview', title: '概要' },
    { key: 'req', type: 'request', num: '①', title: 'codeks → bridge', sub: '客户端请求', target: 'client.request', msg: d.client?.request ?? null }];
  (d.upstream ?? []).forEach((call, i) => {
    const label = callLabel(call.label);
    out.push({ key: `up:${keys[i]}`, type: 'request', num: '②', title: 'bridge → 上游', sub: label, call, msg: call });
    out.push({ key: `upres:${keys[i]}`, type: 'response', num: '③', title: '上游 → bridge', sub: label, call, resp: call.response ?? null });
  });
  out.push({ key: 'res', type: 'response', num: '④', title: 'bridge → codeks', sub: '客户端响应', target: 'client.response', resp: d.client?.response ?? null });
  out.push({ key: 'ann', type: 'ann', title: '标注与工具诊断' });
  out.push({ key: 'diff', type: 'diff', title: '对比' });
  return out;
}

const parsed = new WeakMap();
/** Parses a Body once: {ok, value} or {ok:false, error}. */
export function parseBody(body) {
  if (!body) return { ok: false, error: '没有正文' };
  let r = parsed.get(body);
  if (!r) parsed.set(body, (r = tryJson(body.text)));
  return r;
}

const respSig = (r) => (r ? `${r.status}|${r.end}|${r.ended_ms}|${r.body?.bytes}|${r.events?.length}|${r.error}|${JSON.stringify(r.failure)}` : 'none');

function paneSig(stage, d) {
  if (!stage) return 'missing';
  switch (stage.type) {
    case 'request': return `${stage.msg?.body?.bytes}|${stage.call?.error ?? ''}|${stage.call?.response ? 1 : 0}|${d.tool_diagnostics?.length}`;
    case 'response': return `${respSig(stage.resp)}|${stage.call?.error ?? ''}|${d.annotations?.length}|${d.tool_diagnostics?.length}`;
    case 'diff': return 'diff';
    default: return `${d.rev}|${respSig(d.client?.response)}|${(d.upstream ?? []).map((c) => respSig(c.response)).join(',')}|${d.annotations?.length}`;
  }
}

// Reuse item/event annotation placement without merging tool errors into replay decisions.
const rowAnnotations = (d) => [...(d.annotations ?? []), ...(d.tool_diagnostics ?? []).map(a => ({ ...a, kind: 'tool_error' }))];

// ---------- small renderers ----------

function valueCell(v) {
  if (v === null || v === undefined) return h('span', { class: 'null' }, String(v));
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length <= 200 ? h('span', { class: 'mono' }, s) : jsonTree(v, { auto: 1 });
  }
  if (typeof v === 'string' && v.length > 300) return strBlock(v);
  return h('span', { class: `mono ${typeof v}` }, typeof v === 'string' ? v : String(v));
}

/** Generic key/value table of every field of an object, with Chinese hints for known keys. */
function fieldsTable(obj, hints, skip = []) {
  const rows = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (skip.includes(k)) continue;
    rows.push([h('span', null, hints[k] ? `${hints[k]} ` : '', h('span', { class: 'mono dim' }, k)), valueCell(v)]);
  }
  return kvTable(rows, 'fields-kv');
}

/** Renders server-reported input changes separately from local replay annotations. */
function serverTransformations(resp) {
  const reports = inputTransformationReports(resp);
  if (!reports.length) return null;
  return h('section', { class: 'server-transformations' },
    h('div', { class: 'note' },
      '上游服务端报告 · input_transformations。与 bridge 本地回放过滤分开记录；path 指向本次上游请求。丢弃 thinking 可能损失推理上下文，允许失配不代表已丢弃。'),
    reports.map(report => {
      const where = `${report.event === null ? 'JSON 正文' : `SSE 事件 #${report.event}`} ${report.pointer}`;
      const entries = Array.isArray(report.value) ? report.value : null;
      return h('div', { class: 'transformation-report' },
        h('div', { class: 'sub-title mono' }, where),
        entries?.length === 0 ? h('div', { class: 'dim' }, '服务端报告为空 []') : null,
        entries ? entries.map(entry => h('details', { class: 'transformation-entry' },
          h('summary', null,
            h('span', { class: `chip ${entry?.type === 'thinking_dropped' ? 'warn' : 'info'}` },
              INPUT_TRANSFORMATION_LABEL[entry?.type] ?? entry?.type ?? '未知变换'),
            ' ', h('span', { class: 'mono' }, [entry?.path, entry?.reason].filter(x => x != null).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' · '))),
          jsonTree(entry, { auto: 2 }))) : jsonTree(report.value, { auto: 2 }));
    }));
}

const ROUTE_HINTS = {
  alias: '别名', catalog: '目录模型', adapter: '适配器', api: '上游 API', upstream: '上游配置', base_url: 'base_url', upstream_model: '上游模型',
  origin_id: '来源指纹', reasoning_format: 'reasoning 格式', native_compaction_format: '原生压缩格式', compaction_mode: '压缩模式',
  native_replay: '回放原生压缩', replay: 'replay 白名单', responses_lite: 'responses_lite',
};
const SUMMARY_HINTS = {
  id: 'ID', seq: '序号', rev: '版本', started_at: '开始', duration_ms: '耗时', active: '进行中', model: '模型别名', adapter: '适配器', api: 'API',
  upstream: '上游配置', upstream_model: '上游模型', kind: '类型', stream: '流式', status: '状态码', outcome: '结果', error: '错误', usage: '用量',
  thread: '线程', input_items: 'input 项数', preview: '预览', upstream_calls: '上游调用', bytes: '大小',
  tool_error_count: '本次无效工具调用数',
};

function headersTable(headers, first) {
  const rows = first ? [...first] : [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    const s = Array.isArray(v) ? v.join(', ') : String(v);
    rows.push([h('span', { class: 'mono' }, k), /^\[redacted/.test(s) ? h('span', { class: 'chip warn mono' }, s) : h('span', { class: 'mono hval' }, s)]);
  }
  if (!rows.length) return h('div', { class: 'dim' }, '没有头部');
  return kvTable(rows, 'headers');
}

function rawView(text, name, isJson, ext) {
  let full = false;
  let pretty = false;
  let prettyText = null;
  const pre = h('pre', { class: 'raw' });
  const info = h('span', { class: 'dim' });
  const more = btn('显示全部', () => { full = true; render(); });
  const render = () => {
    if (pretty && prettyText == null) prettyText = JSON.stringify(JSON.parse(text), null, 2);
    const s = pretty ? prettyText : text;
    const cut = !full && s.length > RAW_LIMIT;
    pre.textContent = cut ? s.slice(0, RAW_LIMIT) : s;
    info.textContent = `${fmtInt(s.length)} 字符${cut ? ` · 仅显示前 ${fmtInt(RAW_LIMIT)}` : ''}`;
    more.hidden = !cut;
  };
  const tools = h('div', { class: 'sv-tools' }, info, more,
    isJson ? h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { pretty = e.target.checked; render(); } }), '格式化 JSON') : null,
    btn('复制', () => copyText(text)), btn('下载', () => download(`${name}.${ext}`, text, 'text/plain')));
  render();
  return h('div', { class: 'rawbox' }, tools, pre);
}

/** Annotation pointers usable in the structure view of the client response. */
function responsePointers(d) {
  const resp = d.client?.response;
  const { byPointer, byEvent } = annIndex(rowAnnotations(d), 'client.response');
  if (!byEvent.size) return byPointer;
  const events = parseEvents(resp) ?? [];
  const out = new Map(byPointer);
  for (const [i, list] of byEvent) {
    const oi = events[i]?.json?.output_index;
    if (oi == null) continue;
    for (const a of list) {
      const rest = (a.pointer ?? '').replace(/^\/item/, '');
      const p = `/output/${oi}${rest}`;
      out.set(p, [...(out.get(p) ?? []), a]);
    }
  }
  return out;
}

// ---------- the view ----------

export class DetailView {
  /** ctx: { prefs, savePrefs(), getDetail(id), summaries(), summary(id), live(), select(id), refresh() } */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.detail = null;
    this.states = new Map();
    this.diffSel = new Map();
    this.panes = [{ key: ctx.prefs.pane ?? 'req', el: h('section', { class: 'pane' }), sig: null }];
    this.headEl = h('div', { class: 'd-head' });
    this.navEl = h('nav', { class: 'pipe' });
    this.panesEl = h('div', { class: 'panes' }, this.panes[0].el);
  }

  clear(message) {
    this.detail = null;
    this.root.replaceChildren(h('div', { class: 'empty' }, message));
  }

  /** Shows a detail; same exchange re-renders only panes whose data changed. */
  show(d, { gone = false } = {}) {
    const same = this.detail?.id === d.id;
    this.detail = d;
    this.gone = gone;
    if (!this.root.contains(this.panesEl)) this.root.replaceChildren(this.headEl, this.navEl, this.panesEl);
    const stages = stagesOf(d);
    this.stages = new Map(stages.map((s) => [s.key, s]));
    for (const p of this.panes) if (!this.stages.has(p.key)) p.key = this.fallbackKey(p.key);
    this.renderHead(d);
    this.renderNav(stages);
    for (const p of this.panes) {
      const sig = `${d.id}|${p.key}|${paneSig(this.stages.get(p.key), d)}`;
      if (!same || sig !== p.sig) this.renderPane(p, same);
      p.sig = sig;
    }
  }

  fallbackKey(key) {
    const [kind, label] = key.split(':');
    if (label) {
      const base = label.replace(/#\d+$/, '');
      const hit = [...this.stages.keys()].find((k) => k.startsWith(`${kind}:${base}`)) ?? [...this.stages.keys()].find((k) => k.startsWith(`${kind}:`));
      if (hit) return hit;
      return kind === 'upres' ? 'res' : 'req';
    }
    return 'req';
  }

  open(key, { second = false, mode } = {}) {
    if (!this.detail) return;
    if (mode) this.setMode(this.stages.get(key), mode);
    if (second) {
      if (!this.panes[1]) {
        this.panes.push({ key, el: h('section', { class: 'pane' }), sig: null });
        put(this.panesEl, this.panes[1].el);
        this.panesEl.classList.add('split');
      }
      this.panes[1].key = key;
      this.panes[1].sig = null;
    } else {
      this.panes[0].key = key;
      this.panes[0].sig = null;
      this.ctx.prefs.pane = key;
      this.ctx.savePrefs();
    }
    this.show(this.detail, { gone: this.gone });
  }

  closeSecond() {
    const p = this.panes.pop();
    p?.el.remove();
    this.panesEl.classList.remove('split');
    this.renderNav(stagesOf(this.detail));
  }

  viewState(key, mode, make) {
    const k = `${this.detail.id}|${key}|${mode}`;
    let st = this.states.get(k);
    if (st) { this.states.delete(k); this.states.set(k, st); return st; }
    st = make();
    this.states.set(k, st);
    if (this.states.size > VIEW_STATES) this.states.delete(this.states.keys().next().value);
    return st;
  }

  modeOf(stage) {
    const modes = this.ctx.prefs.modes;
    let m = modes[stage.type] ?? (stage.type === 'response' ? 'events' : 'struct');
    if (m === 'events' && !stage.resp?.events) m = 'struct';
    return m;
  }

  setMode(stage, mode) {
    if (stage) this.ctx.prefs.modes[stage.type] = mode;
    this.ctx.savePrefs();
  }

  // ---------- header and pipeline ----------

  renderHead(d) {
    const th = d.thread ?? {};
    const usage = d.usage ? usageText(d.usage) : '';
    const actions = h('span', { class: 'd-actions' },
      btn('导出此条', () => {
        download(`codeks-bridge-${safeName(d.id)}.json`, JSON.stringify(exportDoc([d]), null, 1));
      }, '', '下载这条记录（可在“导入”中离线查看）'),
      btn('复制 ID', () => copyText(d.id)),
      this.ctx.live() ? btn('刷新', () => this.ctx.refresh(), '', '重新获取这条记录') : null);
    const threadChips = [
      th.thread_id ? h('span', { class: 'chip sm id', title: `thread_id ${th.thread_id}` }, `线程 ${shortId(th.thread_id, 12)}`) : null,
      th.session_id && th.session_id !== th.thread_id ? h('span', { class: 'chip sm id', title: `session_id ${th.session_id}` }, `会话 ${shortId(th.session_id, 12)}`) : null,
      th.parent_thread_id ? h('span', { class: 'chip sm dim', title: `x-codex-parent-thread-id ${th.parent_thread_id}` }, `父线程 ${shortId(th.parent_thread_id, 12)}`) : null,
      th.subagent ? h('span', { class: 'chip sm sub', title: 'x-openai-subagent' }, `子代理 ${th.subagent}`) : null,
      th.window_id ? h('span', { class: 'chip sm dim', title: `x-codex-window-id ${th.window_id}` }, `窗口 ${shortId(th.window_id, 12)}`) : null,
    ];
    fill(this.headEl,
      h('div', { class: 'd-line' },
        h('span', { class: 'd-seq' }, `#${d.seq ?? '?'}`),
        h('span', { class: 'mono dim', title: 'exchange id' }, d.id),
        h('span', { class: 'mono' }, fmtDateTime(d.started_at)),
        h('span', { class: `chip kind k-${d.kind}` }, KIND_LABEL[d.kind] ?? d.kind),
        h('span', { class: 'd-model' }, d.model ?? '（无模型）', d.adapter ? ` → ${d.adapter}` : '', d.upstream_model ? h('span', { class: 'dim' }, ` (${d.upstream_model})`) : null),
        h('span', { class: `chip ${exchangeClass(d)}` }, OUTCOME_LABEL[d.outcome] ?? d.outcome),
        d.status != null ? h('span', { class: 'chip dim', title: 'HTTP 状态码不代表流式响应已完成' }, `HTTP ${d.status}`) : null,
        d.tool_error_count > 0 ? h('button', { class: 'chip bad click', onclick: () => this.open('ann') }, `无效工具调用 ${d.tool_error_count}`) : null,
        h('span', { class: 'mono' }, d.active ? '进行中…' : fmtDur(d.duration_ms)),
        usage ? h('span', { class: 'mono dim', title: JSON.stringify(d.usage, null, 1) }, usage) : null,
        this.gone ? h('span', { class: 'chip warn', title: '已从 bridge 清空或淘汰；这里显示的是浏览器缓存' }, '已从 bridge 移除') : null,
        h('span', { class: 'grow' }), actions),
      threadChips.some(Boolean) || d.error ? h('div', { class: 'd-line' }, threadChips,
        d.error ? h('span', { class: exchangeClass(d) === 'warn' ? 'warning-text' : 'err', title: d.error },
          d.outcome === 'aborted' && exchangeClass(d) === 'warn' ? '客户端连接已断开，原因未确定。' : d.error) : null) : null);
  }

  renderNav(stages) {
    const sel0 = this.panes[0]?.key;
    const sel1 = this.panes[1]?.key;
    const card = (s, main, sub, cls = '', tip = sub) => {
      const el = h('button', {
        type: 'button', class: `card ${cls}${s.key === sel0 ? ' sel' : ''}${s.key === sel1 ? ' sel2' : ''}`, 'data-key': s.key,
        title: `${tip ? `${tip}\n` : ''}Shift+点击：在右侧并排打开`,
        onclick: (e) => this.open(s.key, { second: e.shiftKey }),
      }, h('span', { class: 'card-main' }, main), sub ? h('span', { class: 'card-sub' }, sub) : null);
      return el;
    };
    const d = this.detail;
    const get = (k) => stages.find((s) => s.key === k);
    const req = get('req');
    const res = get('res');
    const reqSub = [fmtBytes(req.msg?.body?.bytes), d.input_items != null ? `${d.input_items} 项` : null].filter(Boolean).join(' · ');
    const respSub = (r, err) => (err && !r ? '传输错误' : r ? [r.status != null ? `HTTP ${r.status}` : '–', responseFailure(r, err) ? '失败' : END_LABEL[r.end] ?? r.end, r.events ? `${fmtInt(r.events.length)} 事件` : fmtBytes(r.body?.bytes)].join(' · ') : '无响应');
    const calls = stages.filter((s) => s.key.startsWith('up:'));
    const callBox = h('div', { class: 'pipe-calls' }, calls.length ? calls.map((s) => {
      const r = get(`upres:${s.key.slice(3)}`);
      return h('div', { class: 'pipe-call' },
        h('span', { class: `call-label l-${s.call.label}` }, s.sub),
        card(s, `② bridge → 上游`, `${s.call.method ?? ''} ${fmtBytes(s.msg?.body?.bytes)}`),
        h('span', { class: 'arrow' }, '→'),
        card(r, `③ 上游 → bridge`, respSub(r.resp, s.call.error), respClass(r.resp, s.call.error)));
    }) : h('span', { class: 'dim' }, '（没有上游调用）'));
    const annCount = d.annotations?.length ?? 0;
    const diagnosticCount = d.tool_diagnostics?.length ?? 0;
    const routeSub = d.route ? `${d.route.alias ?? ''} · ${d.route.compaction_mode ?? ''}` : '无路由';
    fill(this.navEl,
      h('div', { class: 'pipe-side' }, card(get('overview'), '概要', null, 'mini', routeSub), card(get('diff'), '对比', null, 'mini', '与同线程上一轮或任选两条比较')),
      card(req, '① codeks → bridge', reqSub),
      h('span', { class: 'arrow' }, '→'), callBox, h('span', { class: 'arrow' }, '→'),
      card(res, '④ bridge → codeks', respSub(res.resp), respClass(res.resp)),
      h('span', { class: 'grow' }),
      card(get('ann'), `标注 ${annCount} · 诊断 ${diagnosticCount}`, d.tool_error_count > 0 ? `本次无效工具调用 ${d.tool_error_count}` : diagnosticCount ? '历史工具诊断' : annCount ? annSummary(d.annotations) : '无', `narrow${d.tool_error_count > 0 ? ' bad' : diagnosticCount ? ' warn' : annCount ? ' info' : ''}`),
      this.panes[1] ? btn('✕ 关闭并排', () => this.closeSecond(), 'close2') : null);
  }

  // ---------- panes ----------

  renderPane(p, keepScroll) {
    const body = p.el.querySelector('.pane-body');
    const scroll = keepScroll && body ? body.scrollTop : 0;
    const stage = this.stages.get(p.key);
    let content;
    let head;
    try {
      if (stage.type === 'overview') [head, content] = [this.paneHead(stage, p), this.overview()];
      else if (stage.type === 'ann') [head, content] = [this.paneHead(stage, p), this.annotations()];
      else if (stage.type === 'diff') [head, content] = [this.paneHead(stage, p), this.diffPane()];
      else {
        const mode = this.modeOf(stage);
        head = this.paneHead(stage, p, mode);
        content = this.stageBody(stage, mode);
      }
    } catch (e) {
      console.error(e);
      content = h('div', { class: 'err' }, `渲染失败：${e.message}`);
    }
    const nb = h('div', { class: 'pane-body' }, content);
    p.el.replaceChildren(head ?? h('div'), nb);
    if (scroll) nb.scrollTop = scroll;
  }

  paneHead(stage, p, mode) {
    const title = stage.num ? `${stage.num} ${stage.title} · ${stage.sub}` : stage.title;
    const head = h('div', { class: 'pane-head' }, h('span', { class: 'pane-title' }, title));
    if (mode) {
      const modes = stage.type === 'request' ? REQUEST_MODES : RESPONSE_MODES.filter(([m]) => m !== 'events' || stage.resp?.events);
      put(head, h('span', { class: 'tabs' }, modes.map(([m, label]) => h('button', {
        type: 'button', class: `tab${m === mode ? ' on' : ''}`,
        onclick: () => { this.setMode(stage, m); for (const x of this.panes) if (this.stages.get(x.key)?.type === stage.type) { x.sig = null; this.renderPane(x, false); } },
      }, label))));
      put(head, this.stageInfo(stage));
    }
    if (p === this.panes[1]) put(head, h('span', { class: 'grow' }), btn('✕', () => this.closeSecond(), '', '关闭并排'));
    return head;
  }

  stageInfo(stage) {
    const out = h('span', { class: 'pane-info' });
    const body = stage.type === 'request' ? stage.msg?.body : stage.resp?.body;
    if (stage.type === 'request') {
      const m = stage.msg;
      if (m) put(out, h('span', { class: 'mono', title: m.url ?? m.path }, `${m.method ?? ''} ${oneLine(m.url ?? m.path ?? '', 80)}`));
      if (stage.call?.started_ms != null) put(out, h('span', { class: 'dim' }, `开始 +${fmtDur(stage.call.started_ms)}`));
      if (stage.call?.error) put(out, h('span', { class: 'chip bad' }, `传输错误：${stage.call.error}`));
    } else {
      const r = stage.resp;
      if (!r) put(out, h('span', { class: 'dim' }, stage.call?.error ? `传输错误：${stage.call.error}` : '尚无响应'));
      else {
        const failure = responseFailure(r, stage.call?.error);
        put(out, h('span', { class: 'chip dim' }, `HTTP ${r.status ?? '–'} ${r.status_text ?? ''}`.trim()),
          h('span', { class: `chip ${respClass(r, stage.call?.error)}`, title: `end: ${r.end}` }, failure ? '失败' : r.end === 'cancelled' && stage.target === 'client.response' ? '客户端断开' : END_LABEL[r.end] ?? r.end ?? '–'),
          r.headers_ms != null ? h('span', { class: 'dim', title: '自请求开始到响应头的时间' }, `响应头 ${fmtDur(r.headers_ms)}`) : null,
          r.ended_ms != null ? h('span', { class: 'dim', title: '自请求开始到结束的时间' }, `结束 ${fmtDur(r.ended_ms)}`) : null,
          r.events ? h('span', { class: 'dim' }, `${fmtInt(r.events.length)} 事件`) : h('span', { class: 'dim' }, '非 SSE'),
          failure ? h('span', { class: 'chip bad', title: failure.message ?? failure.kind }, oneLine(`错误：${failure.message ?? failure.kind}`, 80)) : null);
      }
    }
    if (body) {
      put(out, h('span', { class: 'dim', title: `${fmtInt(body.bytes)} 字节` }, fmtBytes(body.bytes)));
      put(out, btn('复制正文', () => copyText(body.text)), btn('下载正文', () => download(this.fileName(stage, stage.resp?.events ? 'sse.txt' : 'json'), body.text, 'text/plain')));
    }
    return out;
  }

  fileName(stage, ext) {
    return `${safeName(this.detail.id)}-${safeName(stage.key.replace(':', '-'))}.${ext}`;
  }

  stageBody(stage, mode) {
    const d = this.detail;
    const isReq = stage.type === 'request';
    const msg = stage.msg;
    const resp = stage.resp;
    const body = isReq ? msg?.body : resp?.body;
    if (!isReq && !resp) {
      return h('div', { class: 'empty small' }, stage.call?.error ? `上游传输错误，没有响应：${stage.call.error}` : d.active ? '等待响应…' : '没有响应');
    }
    if (!isReq && mode === 'headers') {
      return headersTable(resp.headers, [['状态', h('span', { class: 'mono' }, `${resp.status ?? '–'} ${resp.status_text ?? ''}`)]]);
    }
    if (isReq && mode === 'headers') {
      return headersTable(msg?.headers, [['请求', h('span', { class: 'mono' }, `${msg?.method ?? ''} ${msg?.url ?? msg?.path ?? ''}`)]]);
    }
    if (mode === 'raw') return body ? rawView(body.text, this.fileName(stage, 'body'), parseBody(body).ok, resp?.events ? 'sse.txt' : 'json') : h('div', { class: 'dim' }, '没有正文');
    const ann = stage.target === 'client.request' ? annIndex(rowAnnotations(d), 'client.request').byPointer
      : stage.target === 'client.response' ? responsePointers(d) : null;
    const chip = (a, onClick) => annChip(a, onClick);
    if (mode === 'events' && resp?.events) {
      const { byEvent } = annIndex(rowAnnotations(d), stage.target === 'client.response' ? 'client.response' : '-');
      return eventsView(resp, {
        state: this.viewState(stage.key, 'events', newEventsState), prefs: this.ctx.prefs,
        onPrefs: () => { this.ctx.savePrefs(); for (const p of this.panes) { if (this.modeOf(this.stages.get(p.key) ?? {}) === 'events') this.renderPane(p, true); } },
        annByEvent: byEvent, annChip: chip, annDetail,
      });
    }
    if (mode === 'json') {
      const st = this.viewState(stage.key, 'json', () => ({ exp: new Set() }));
      if (resp?.events) {
        const events = parseEvents(resp).map((e) => ({ t: e.t, event: e.event, data: e.json !== undefined ? e.json : e.data }));
        return h('div', null, h('div', { class: 'note' }, `全部 ${fmtInt(events.length)} 个 SSE 事件（data 已解析为 JSON）`), jsonTree(events, { state: st, label: 'events', auto: 1 }));
      }
      const r = parseBody(body);
      if (!r.ok) return h('div', null, h('div', { class: 'note' }, `正文不是合法 JSON：${r.error}`), strBlock(body?.text ?? ''));
      return jsonTree(r.value, { state: st, ann, annChip: chip, label: 'body', auto: 1 });
    }
    // Structure view.
    const st = this.viewState(stage.key, 'struct', newStructState);
    if (isReq) {
      const r = parseBody(body);
      if (!r.ok) return h('div', null, h('div', { class: 'note' }, `正文不是合法 JSON：${r.error}`), strBlock(body?.text ?? ''));
      return structureView(r.value, { state: st, ann, annChip: chip });
    }
    const fo = finalObject(resp);
    return h('div', null,
      stage.call ? serverTransformations(resp) : null,
      structureView(fo.value, { state: st, ann, annChip: chip, note: fo.note }));
  }

  // ---------- overview ----------

  overview() {
    const d = this.detail;
    const box = h('div', { class: 'overview' });
    put(box, h('h4', null, '路由'), d.route ? fieldsTable(d.route, ROUTE_HINTS) : h('div', { class: 'dim' }, '没有路由信息（请求无法解析或路由失败）'));
    put(box, h('h4', null, '时间线'), this.timeline());
    put(box, h('h4', null, '流式内容延迟'), this.latency());
    const keys = callKeys(d.upstream);
    if (d.upstream?.length) {
      put(box, h('h4', null, `上游调用（${d.upstream.length}）`), h('table', { class: 'calls' },
        h('thead', null, h('tr', null, ['标签', '请求', '状态', '结束', '开始', '响应头于', '结束于', '请求大小', '响应大小', '错误'].map((x) => h('th', null, x)))),
        h('tbody', null, d.upstream.map((c, i) => {
          const r = c.response;
          const tr = h('tr', { class: 'clickable', title: '打开该调用的上游响应', onclick: () => this.open(`upres:${keys[i]}`) },
            h('td', null, h('span', { class: `call-label l-${c.label}` }, callLabel(c.label))),
            h('td', { class: 'mono' }, `${c.method ?? ''} ${oneLine(c.url ?? '', 70)}`),
            h('td', null, h('span', { class: `chip ${respClass(r, c.error)}` }, r?.status ?? '–')),
            h('td', null, END_LABEL[r?.end] ?? r?.end ?? '–'),
            h('td', { class: 'mono' }, c.started_ms != null ? `+${fmtDur(c.started_ms)}` : '–'),
            h('td', { class: 'mono' }, r?.headers_ms != null ? fmtDur(r.headers_ms) : '–'),
            h('td', { class: 'mono' }, r?.ended_ms != null ? fmtDur(r.ended_ms) : '–'),
            h('td', { class: 'mono' }, fmtBytes(c.body?.bytes)),
            h('td', { class: 'mono' }, fmtBytes(r?.body?.bytes)),
            h('td', { class: 'err' }, responseFailure(r, c.error)?.message ?? ''));
          return tr;
        }))));
    }
    if (d.annotations?.length) {
      put(box, h('h4', null, '标注'), h('div', null, h('span', { class: 'chip info' }, annSummary(d.annotations)), ' ', btn('查看全部标注', () => this.open('ann'))));
    }
    if (d.tool_diagnostics?.length) put(box, this.toolDiagnostics());
    for (const [i, call] of (d.upstream ?? []).entries()) {
      const reports = serverTransformations(call.response);
      if (reports) {
        put(box, h('h4', null, `服务端输入变换 · ${callLabel(call.label)} (${keys[i]})`),
          btn('查看上游响应', () => this.open(`upres:${keys[i]}`)), reports);
      }
    }
    put(box, h('h4', null, '记录字段'), fieldsTable(d, SUMMARY_HINTS, ['route', 'client', 'upstream', 'annotations', 'tool_diagnostics']));
    return box;
  }

  timeline() {
    const d = this.detail;
    const rows = [];
    const keys = callKeys(d.upstream);
    const cr = d.client?.response;
    (d.upstream ?? []).forEach((c, i) => rows.push({ label: callLabel(c.label), start: c.started_ms ?? 0, head: c.response?.headers_ms, end: c.response?.ended_ms, cls: respClass(c.response, c.error), key: `upres:${keys[i]}` }));
    rows.push({ label: 'bridge → codeks', start: 0, head: cr?.headers_ms, end: cr?.ended_ms, cls: respClass(cr), key: 'res' });
    const now = d.active ? Date.now() - d.started_at : 0;
    const total = Math.max(1, d.duration_ms ?? 0, now, ...rows.map((r) => r.end ?? r.head ?? r.start));
    const pct = (v) => `${Math.max(0, Math.min(100, (v / total) * 100)).toFixed(2)}%`;
    return h('div', { class: 'timeline' }, rows.map((r) => {
      const end = r.end ?? (d.active ? total : r.head ?? r.start);
      const bar = h('span', { class: `tl-bar ${r.cls}` });
      bar.style.left = pct(r.start);
      bar.style.width = pct(Math.max(end - r.start, total / 400));
      const mark = r.head != null ? h('span', { class: 'tl-head', title: `响应头 ${fmtDur(r.head)}` }) : null;
      if (mark) mark.style.left = pct(r.head);
      return h('div', { class: 'tl-row clickable', onclick: () => this.open(r.key) },
        h('span', { class: 'tl-label' }, r.label),
        h('span', { class: 'tl-track' }, bar, mark),
        h('span', { class: 'tl-num mono' }, `${fmtDur(r.start)} → ${r.head != null ? fmtDur(r.head) : '–'} → ${r.end != null ? fmtDur(r.end) : d.active ? '…' : '–'}`));
    }), h('div', { class: 'dim tl-axis' }, `0 → ${fmtDur(total)}（开始 → 响应头 → 结束，相对请求开始）`));
  }

  latency() {
    const d = this.detail;
    const rows = (d.upstream ?? []).map(c => ({
      label: `${callLabel(c.label)} → bridge`,
      value: responseLatency(c.response, c.started_ms),
    }));
    rows.push({ label: 'bridge → codeks', value: responseLatency(d.client?.response, 0, true) });
    return h('div', null,
      h('div', { class: 'note' }, '上游从各自调用开始计时；写回 codeks 从客户端请求开始计时，包含前置 handoff。只计文字、reasoning 或工具内容，响应头和 keepalive 不计。这里是到达或写出时间，不是模型生成或 TUI 渲染时间。'),
      h('table', { class: 'calls' },
        h('thead', null, h('tr', null, ['方向', '首内容', '首文字', '首 reasoning', '首工具'].map(x => h('th', null, x)))),
        h('tbody', null, rows.map(({ label, value }) => h('tr', null,
          h('td', null, label),
          ['content_ms', 'text_ms', 'reasoning_ms', 'tool_ms'].map(key => h('td', { class: 'mono' }, value?.[key] != null ? fmtDur(value[key]) : '—')))))),
      h('div', { class: 'dim' }, '— 表示未观测到或无法测量；JSON 响应和缺少时间戳的导入不估算。上游 reasoning 可包含不透明载荷；写回 codeks 仅计可见摘要。工具以首次名称或参数为准，压缩密文不计入这些指标。'));
  }

  // ---------- annotations ----------

  toolDiagnostics() {
    const list = this.detail.tool_diagnostics ?? [];
    if (!list.length) return null;
    return h('section', null,
      h('h4', null, '工具诊断'),
      h('div', { class: 'note' }, '本次输出的无效调用与响应是否完成分别显示。历史输入中的诊断仅用于回溯，不计入本次无效调用数。'),
      list.map(item => {
        const a = { ...item, kind: 'tool_error' };
        return h('details', { class: 'transformation-entry' },
          h('summary', null, annChip(a), ' ', h('span', { class: 'mono dim' }, `${a.pointer}${a.event != null ? ` · 事件 #${a.event}` : ''}`), ' ',
            btn('定位', e => { e.preventDefault(); this.locate(a); })),
          annDetail(a));
      }));
  }

  annotations() {
    const d = this.detail;
    const list = d.annotations ?? [];
    if (!list.length) return this.toolDiagnostics() ?? h('div', { class: 'empty small' }, '这条记录没有回放标注或工具诊断');
    const tbody = h('tbody');
    list.forEach((a, i) => {
      const where = `${a.target === 'client.request' ? '① 请求' : '④ 响应'}${a.event != null ? ` 事件 #${a.event}` : ''} ${a.pointer ?? ''}`;
      const tr = h('tr', { class: 'clickable' },
        h('td', { class: 'mono dim' }, String(i)),
        h('td', { class: 'mono' }, where),
        h('td', null, KIND_TEXT[a.kind] ?? a.kind),
        h('td', null, h('span', { class: `chip ${decisionClass(a.decision)}` }, decisionText(a.decision))),
        h('td', null, reasonText(a), h('span', { class: 'dim mono' }, ` ${a.reason}`)),
        h('td', null, sourceText(a.source) || '–'),
        h('td', { class: 'mono dim' }, a.format ?? '–'),
        h('td', null, btn('定位', () => this.locate(a), '', '在结构/事件视图中定位这一项')));
      const detailRow = h('tr', { class: 'field-detail' }, h('td', { colSpan: 8 }));
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button') || String(window.getSelection?.() ?? '')) return;
        if (detailRow.isConnected) detailRow.remove();
        else { if (!detailRow.firstChild.firstChild) put(detailRow.firstChild, annDetail(a)); tr.after(detailRow); }
      });
      put(tbody, tr);
    });
    return h('div', null,
      this.toolDiagnostics(),
      h('div', { class: 'note' }, `bridge 按真实回放规则计算：${annSummary(list)}。点击行查看解码后的载荷，“定位”跳到对应项。`),
      h('table', { class: 'anns' }, h('thead', null, h('tr', null, ['#', '位置', '类型', '决定', '原因', '来源', '格式', ''].map((x) => h('th', null, x)))), tbody));
  }

  /** Opens the item or event an annotation points at, expanded and highlighted. */
  locate(a) {
    const isReq = a.target === 'client.request';
    const key = isReq ? 'req' : 'res';
    const stage = this.stages.get(key);
    const mode = !isReq && a.event != null && stage.resp?.events ? 'events' : 'struct';
    let selector;
    if (mode === 'events') {
      const st = this.viewState(key, 'events', newEventsState);
      st.open.add(`e${a.event}`);
      st.type = '';
      st.q = '';
      st.shown = Infinity;
      selector = `[data-ev="${a.event}"]`;
    } else {
      const st = this.viewState(key, 'struct', newStructState);
      st.filters.clear();
      let pointer = a.pointer;
      if (!isReq && a.event != null) {
        const oi = parseEvents(stage.resp)?.[a.event]?.json?.output_index;
        pointer = oi != null ? `/output/${oi}` : null;
      }
      const row = focusPointer(st, pointer);
      selector = row ? `[data-ptr="${CSS.escape(row)}"]` : null;
    }
    this.open(key, { mode });
    const pane = this.panes[0];
    requestAnimationFrame(() => {
      const el = selector && pane.el.querySelector(selector);
      if (!el) { toast('没有找到对应的项'); return; }
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1800);
    });
  }

  // ---------- diff ----------

  /** Previous exchange in the same thread, optionally one with an upstream call of that label. */
  previous(d, label) {
    const key = threadKey(d);
    if (!key) return null;
    return [...this.ctx.summaries().values()].filter((s) => s.id !== d.id && threadKey(s) === key && byNewest(d, s) < 0 &&
      (!label || (s.upstream_calls ?? []).some((c) => c.label === label))).sort(byNewest)[0] ?? null;
  }

  diffPane() {
    const d = this.detail;
    let sel = this.diffSel.get(d.id);
    if (!sel) {
      const prev = this.previous(d);
      sel = { a: { id: prev?.id ?? null, stage: 'req' }, b: { id: d.id, stage: 'req' } };
      this.diffSel.set(d.id, sel);
    }
    const out = h('div', { class: 'diff-result' });
    const run = () => this.runDiff(sel, out);
    const side = (name, s) => {
      const exSel = h('select', { class: 'sel ex-sel' });
      const stSel = h('select', { class: 'sel' });
      const fillStages = () => {
        const sum = this.ctx.summary(s.id);
        const opts = stageOptions(sum);
        if (!opts.some(([k]) => k === s.stage)) s.stage = opts[0]?.[0] ?? 'req';
        stSel.replaceChildren(...opts.map(([k, label]) => h('option', { value: k, selected: k === s.stage }, label)));
      };
      const all = [...this.ctx.summaries().values()].sort(byNewest);
      const key = threadKey(d);
      const mk = (x) => h('option', { value: x.id, selected: x.id === s.id }, `#${x.seq ?? '?'} ${fmtTime(x.started_at)} ${x.model ?? '?'} ${KIND_LABEL[x.kind] ?? ''}${x.id === d.id ? '（当前）' : ''}`);
      const same = all.filter((x) => key && threadKey(x) === key);
      const other = all.filter((x) => !key || threadKey(x) !== key);
      put(exSel, h('option', { value: '', selected: !s.id }, '（选择记录）'),
        same.length ? h('optgroup', { label: '同一线程' }, same.map(mk)) : null,
        other.length ? h('optgroup', { label: key ? '其他线程' : '全部' }, other.map(mk)) : null);
      exSel.addEventListener('change', () => { s.id = exSel.value || null; fillStages(); run(); });
      stSel.addEventListener('change', () => { s.stage = stSel.value; run(); });
      fillStages();
      return h('span', { class: 'diff-side' }, h('b', null, name), exSel, stSel);
    };
    const preset = (label, stage, callLbl) => btn(label, () => {
      const prev = this.previous(d, callLbl);
      if (!prev) { toast(callLbl ? `同一线程中没有更早的带“${callLabel(callLbl)}”的记录` : '同一线程中没有更早的记录'); return; }
      sel.a = { id: prev.id, stage };
      sel.b = { id: d.id, stage };
      this.renderPane(this.panes.find((p) => p.key === 'diff') ?? this.panes[0], false);
    });
    const labels = [...new Set((d.upstream ?? []).map((c) => c.label))];
    const tools = h('div', { class: 'diff-tools' },
      side('A', sel.a), btn('⇄', () => { [sel.a, sel.b] = [sel.b, sel.a]; this.renderPane(this.panes.find((p) => p.key === 'diff') ?? this.panes[0], false); }, '', '交换 A 与 B'), side('B', sel.b));
    const presets = h('div', { class: 'diff-tools' }, h('span', { class: 'dim' }, '快捷：'),
      preset('上一轮 · 客户端请求', 'req'),
      labels.map((l) => preset(`上一轮 · 上游请求·${callLabel(l)}`, `up:${l}`, l)),
      preset('上一轮 · 客户端响应', 'res'));
    queueMicrotask(run);
    return h('div', { class: 'diffpane' }, tools, presets, out);
  }

  async runDiff(sel, out) {
    const token = (this.diffToken = (this.diffToken ?? 0) + 1);
    if (!sel.a.id || !sel.b.id) {
      out.replaceChildren(h('div', { class: 'empty small' }, sel.a.id || sel.b.id ? '请选择 A 与 B 两侧的记录' : '同一线程中没有更早的记录；请在上方手动选择 A。'));
      return;
    }
    out.replaceChildren(h('div', { class: 'dim' }, '加载并比较中…'));
    try {
      const [a, b] = await Promise.all([this.diffValue(sel.a), this.diffValue(sel.b)]);
      await new Promise((r) => setTimeout(r, 0));
      if (token !== this.diffToken) return;
      out.replaceChildren(h('div', { class: 'diff-legend dim' }, `A = ${a.label}　B = ${b.label}`), diffView(a.value, b.value, { label: 'body' }));
    } catch (e) {
      if (token === this.diffToken) out.replaceChildren(h('div', { class: 'err' }, `无法比较：${e.message}`));
    }
  }

  async diffValue(s) {
    const det = await this.ctx.getDetail(s.id);
    const stage = stagesOf(det).find((x) => x.key === s.stage);
    if (!stage) throw new Error(`记录 ${s.id} 没有阶段 ${s.stage}`);
    const label = `#${det.seq} ${fmtTime(det.started_at)} ${det.model ?? ''} · ${stage.num} ${stage.sub}`;
    if (stage.type === 'request') {
      const r = parseBody(stage.msg?.body);
      return { label, value: r.ok ? r.value : stage.msg?.body?.text ?? null };
    }
    return { label, value: finalObject(stage.resp)?.value ?? null };
  }
}

function stageOptions(sum) {
  if (!sum) return [['req', '① 客户端请求'], ['res', '④ 客户端响应（最终对象）']];
  const keys = callKeys(sum.upstream_calls ?? sum.upstream);
  const out = [['req', '① 客户端请求']];
  keys.forEach((k, i) => {
    const l = callLabel((sum.upstream_calls ?? sum.upstream)[i].label);
    out.push([`up:${k}`, `② 上游请求 · ${l}`], [`upres:${k}`, `③ 上游响应 · ${l}（最终对象）`]);
  });
  out.push(['res', '④ 客户端响应（最终对象）']);
  return out;
}

function annSummary(list) {
  const counts = new Map();
  for (const a of list) {
    const k = `${KIND_TEXT[a.kind] ?? a.kind} ${decisionText(a.decision)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k} ${n}`).join(' · ');
}
