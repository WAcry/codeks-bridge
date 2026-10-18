// SSE event list with delta grouping, plus synthesis of the final response
// object from a stream (used by the structure view and the diff).
import { h, btn, fmtInt, fmtOffset, oneLine, strBlock, tryJson, shortId, put } from './dom.js';
import { jsonTree } from './tree.js';

const ROW_PAGE = 1000;

export const isKeepalive = (ev) => ev.event === 'ping' || ev.event === 'keepalive' || ev.json?.type === 'keepalive' || ev.json?.type === 'ping';

/** Parses events once per response object. */
const parsedCache = new WeakMap();
export function parseEvents(resp) {
  if (!resp?.events) return null;
  let list = parsedCache.get(resp.events);
  if (!list) {
    list = resp.events.map((e, i) => {
      const r = tryJson(e.data);
      return { i, t: e.t, event: e.event ?? null, data: e.data, json: r.ok ? r.value : undefined };
    });
    parsedCache.set(resp.events, list);
  }
  return list;
}

/** Returns {key, text, label} for streaming delta events of Responses, Messages and Chat. */
function deltaOf(ev) {
  const j = ev.json;
  if (!j || typeof j !== 'object') return null;
  if (typeof j.type === 'string' && j.type.endsWith('.delta') && typeof j.delta === 'string') {
    return { key: [j.type, j.item_id, j.output_index, j.content_index, j.summary_index].join('|'), text: j.delta, label: j.type };
  }
  if (j.type === 'content_block_delta' && j.delta) {
    const d = j.delta;
    const text = d.text ?? d.thinking ?? d.partial_json ?? d.signature;
    if (typeof text === 'string') return { key: `cbd|${d.type}|${j.index}`, text, label: `content_block_delta · ${d.type}` };
  }
  if (Array.isArray(j.choices) && j.choices.length === 1 && j.choices[0].delta && !j.choices[0].finish_reason && !j.usage) {
    const c = j.choices[0];
    const d = c.delta;
    const keys = Object.keys(d).filter((k) => d[k] != null && d[k] !== '');
    if (keys.length === 1 && (keys[0] === 'content' || keys[0] === 'reasoning_content') && typeof d[keys[0]] === 'string') {
      return { key: `chat|${keys[0]}|${c.index}`, text: d[keys[0]], label: `delta.${keys[0]}` };
    }
    if (keys.length === 1 && keys[0] === 'tool_calls' && d.tool_calls.length === 1) {
      const tc = d.tool_calls[0];
      if (!tc.id && !tc.function?.name && typeof tc.function?.arguments === 'string') {
        return { key: `chat|tool|${c.index}|${tc.index}`, text: tc.function.arguments, label: `delta.tool_calls[${tc.index}].arguments` };
      }
    }
  }
  return null;
}

// Label: the SSE event name, else data.type (most streams are data-only).
function eventType(ev) {
  return ev.event ?? ev.json?.type ?? (ev.json?.object || (ev.data === '[DONE]' ? '[DONE]' : '(data)'));
}

/** One-line description of an event, picking common fields of all three APIs. */
function describe(ev) {
  const j = ev.json;
  if (j === undefined) return oneLine(ev.data, 160);
  if (!j || typeof j !== 'object') return JSON.stringify(j);
  const out = [];
  const r = j.response;
  if (r && typeof r === 'object') {
    out.push(`status=${r.status}`);
    if (r.model) out.push(r.model);
    if (r.usage) out.push(usageText(r.usage));
    if (r.error) out.push(`error: ${r.error.message ?? JSON.stringify(r.error)}`);
    if (r.incomplete_details) out.push(JSON.stringify(r.incomplete_details));
  }
  const item = j.item ?? j.content_block ?? j.part;
  if (item && typeof item === 'object') {
    out.push([item.type, item.role, item.name, item.phase && `phase:${item.phase}`].filter(Boolean).join(' '));
    if (typeof item.encrypted_content === 'string') out.push(`encrypted ${fmtInt(item.encrypted_content.length)}${/^cx/.test(item.encrypted_content) ? ` (${item.encrypted_content.slice(0, 5)})` : ''}`);
    const text = item.text ?? item.thinking ?? item.arguments ?? item.content?.[0]?.text;
    if (typeof text === 'string' && text) out.push(oneLine(text, 80));
    if (item.id) out.push(shortId(item.id, 16));
  }
  if (j.output_index != null) out.push(`out#${j.output_index}`);
  if (j.index != null && j.type?.startsWith('content_block')) out.push(`block#${j.index}`);
  if (j.type === 'content_block_delta' && j.delta?.type) {
    const t = j.delta.text ?? j.delta.thinking ?? j.delta.partial_json ?? j.delta.signature;
    out.push(`${j.delta.type}${typeof t === 'string' ? ` ${fmtInt(t.length)} 字符 ${oneLine(t, 60)}` : ''}`);
  }
  if (typeof j.delta === 'string') out.push(oneLine(j.delta, 100));
  if (typeof j.text === 'string') out.push(oneLine(j.text, 100));
  if (j.message && typeof j.message === 'object') out.push([j.message.model, j.message.usage && usageText(j.message.usage)].filter(Boolean).join(' '));
  if (j.delta && typeof j.delta === 'object' && !Array.isArray(j.delta) && j.type === 'message_delta') out.push(JSON.stringify(j.delta));
  if (j.usage) out.push(usageText(j.usage));
  if (Array.isArray(j.choices)) {
    for (const c of j.choices) {
      if (c.finish_reason) out.push(`finish=${c.finish_reason}`);
      if (c.delta?.role) out.push(`role=${c.delta.role}`);
      for (const tc of c.delta?.tool_calls ?? []) out.push(`tool_call[${tc.index}] ${tc.function?.name ?? ''} ${tc.id ?? ''}`.trim());
    }
  }
  if (j.error) out.push(`error: ${j.error.message ?? JSON.stringify(j.error)}`);
  if (typeof j.sequence_number === 'number') out.push(`seq ${j.sequence_number}`);
  return out.filter(Boolean).join(' · ') || oneLine(ev.data, 160);
}

export function usageText(u) {
  if (!u || typeof u !== 'object') return '';
  const pick = (...ks) => { for (const k of ks) { const v = k.split('.').reduce((o, p) => o?.[p], u); if (typeof v === 'number') return v; } return null; };
  const parts = [];
  const add = (label, v) => { if (v != null) parts.push(`${label} ${fmtInt(v)}`); };
  add('in', pick('input_tokens', 'prompt_tokens'));
  add('out', pick('output_tokens', 'completion_tokens'));
  add('cached', pick('input_tokens_details.cached_tokens', 'cache_read_input_tokens', 'prompt_cache_hit_tokens', 'prompt_tokens_details.cached_tokens'));
  add('cache_write', pick('cache_creation_input_tokens'));
  add('reasoning', pick('output_tokens_details.reasoning_tokens', 'completion_tokens_details.reasoning_tokens'));
  return parts.join(' / ');
}

export function newEventsState() {
  return { open: new Set(), openGroups: new Set(), groupEvents: new Set(), trees: new Map(), shown: ROW_PAGE, type: '', q: '' };
}

/**
 * opts: { state, prefs: {keepalive, merge}, onPrefs(), annByEvent: Map<index, Annotation[]>, annChip, annDetail }
 */
export function eventsView(resp, opts) {
  const st = opts.state;
  const prefs = opts.prefs;
  const all = parseEvents(resp);
  const root = h('div', { class: 'events' });
  const keep = all.filter(isKeepalive).length;
  const visible = prefs.keepalive ? all : all.filter((e) => !isKeepalive(e));
  const types = new Map();
  for (const e of visible) { const t = eventType(e); types.set(t, (types.get(t) ?? 0) + 1); }
  const typeSel = h('select', { class: 'sel', title: '按类型筛选' },
    h('option', { value: '' }, `全部类型（${types.size}）`),
    [...types].sort((a, b) => b[1] - a[1]).map(([t, n]) => h('option', { value: t, selected: st.type === t }, `${t} ×${n}`)));
  const q = h('input', { type: 'search', class: 'list-filter', placeholder: '搜索事件 data', value: st.q });
  const list = h('div', { class: 'ev-list' });
  const info = h('span', { class: 'dim' });
  const toggle = (label, key, title) => h('label', { class: 'check', title },
    h('input', { type: 'checkbox', checked: !!prefs[key], onchange: (e) => { prefs[key] = e.target.checked; opts.onPrefs(); } }), label);
  put(root, h('div', { class: 'ev-tools' }, info, typeSel, q,
    toggle(`显示 keepalive/ping（${keep}）`, 'keepalive', '心跳事件默认隐藏'),
    toggle('合并连续 delta', 'merge', '同一类型、同一 item/index 的连续 delta 合并为一行')), list);

  const render = () => {
    list.replaceChildren();
    const needle = st.q.toLowerCase();
    const events = visible.filter((e) => (!st.type || eventType(e) === st.type) && (!needle || e.data.toLowerCase().includes(needle)));
    const rows = [];
    for (const e of events) {
      const d = prefs.merge ? deltaOf(e) : null;
      const last = rows[rows.length - 1];
      if (d && last?.key === d.key) { last.events.push(e); last.parts.push(d.text); continue; }
      rows.push(d ? { key: d.key, label: d.label, events: [e], parts: [d.text] } : { events: [e] });
    }
    info.textContent = `共 ${fmtInt(all.length)} 个事件 · 显示 ${fmtInt(events.length)} · ${fmtInt(rows.length)} 行`;
    const limit = st.shown;
    for (const r of rows.slice(0, limit)) put(list, r.key && r.events.length > 1 ? groupRow(r, opts) : eventRow(r.events[0], opts));
    if (rows.length > limit) put(list, btn(`显示其余 ${fmtInt(rows.length - limit)} 行`, () => { st.shown = Infinity; render(); }, 'more'));
  };
  typeSel.addEventListener('change', () => { st.type = typeSel.value; render(); });
  q.addEventListener('input', () => { st.q = q.value; render(); });
  render();
  return root;
}

function treeState(st, key) {
  let t = st.trees.get(key);
  if (!t) st.trees.set(key, (t = { exp: new Set() }));
  return t;
}

function eventRow(e, opts) {
  const st = opts.state;
  const anns = opts.annByEvent?.get(e.i);
  const wrap = h('div', { class: `ev${isKeepalive(e) ? ' keep' : ''}`, dataset: { ev: e.i } });
  const tog = h('span', { class: 'tn-tog' }, '▸');
  const type = eventType(e);
  const row = h('div', { class: 'ev-row' }, tog,
    h('span', { class: 'ev-t' }, fmtOffset(e.t)),
    h('span', { class: 'ev-i' }, `#${e.i}`),
    h('span', { class: `ev-type${/error|failed/.test(type) ? ' err' : ''}`, title: e.event ? 'SSE event 字段' : 'data.type' }, type),
    e.event && typeof e.json?.type === 'string' && e.json.type !== e.event ? h('span', { class: 'chip dim', title: 'data.type' }, e.json.type) : null,
    h('span', { class: 'pv' }, describe(e)),
    anns?.map((a) => opts.annChip(a, () => open(!st.open.has(key)))));
  const body = h('div', { class: 'ev-body' });
  put(wrap, row);
  const key = `e${e.i}`;
  const open = (on) => {
    if (on) {
      st.open.add(key);
      if (!body.firstChild) {
        if (anns) put(body, ...anns.map(opts.annDetail));
        put(body, e.json !== undefined ? jsonTree(e.json, { state: treeState(st, key), auto: 3 }) : strBlock(e.data, { name: `event-${e.i}` }));
      }
      put(wrap, body);
    } else { st.open.delete(key); body.remove(); }
    tog.textContent = on ? '▾' : '▸';
  };
  row.addEventListener('click', (ev) => {
    if (ev.target.closest('button, .chip') || String(window.getSelection?.() ?? '')) return;
    open(!st.open.has(key));
  });
  if (st.open.has(key)) open(true);
  return wrap;
}

function groupRow(r, opts) {
  const st = opts.state;
  const first = r.events[0];
  const lastEv = r.events[r.events.length - 1];
  const text = r.parts.join('');
  const key = `g${first.i}`;
  const wrap = h('div', { class: 'ev group' });
  const tog = h('span', { class: 'tn-tog' }, '▸');
  const row = h('div', { class: 'ev-row' }, tog,
    h('span', { class: 'ev-t' }, `${fmtOffset(first.t)}→${fmtOffset(lastEv.t).slice(1)}`),
    h('span', { class: 'ev-i' }, `#${first.i}–${lastEv.i}`),
    h('span', { class: 'ev-type' }, r.label),
    h('span', { class: 'chip info' }, `×${r.events.length}`),
    h('span', { class: 'pv' }, oneLine(text, 220) || '(空)'),
    h('span', { class: 'metrics' }, `${fmtInt(text.length)} 字符`));
  const body = h('div', { class: 'ev-body' });
  put(wrap, row);
  const open = (on) => {
    if (on) {
      st.openGroups.add(key);
      if (!body.firstChild) {
        const sub = h('div', { class: 'ev-sub' });
        const showEvents = (show) => {
          if (show) { st.groupEvents.add(key); for (const e of r.events.slice(0, 2000)) put(sub, eventRow(e, opts)); if (r.events.length > 2000) put(sub, h('div', { class: 'dim' }, `仅显示前 2000 个，可在“原始”中查看全部`)); }
          else { st.groupEvents.delete(key); sub.replaceChildren(); }
        };
        put(body, h('div', { class: 'sub-title' }, '合并后的文本'), strBlock(text, { name: 'merged', tree: (v, label) => jsonTree(v, { label, auto: 2 }) }),
          btn(`逐条显示 ${fmtInt(r.events.length)} 个事件`, () => showEvents(!st.groupEvents.has(key))), sub);
        if (st.groupEvents.has(key)) showEvents(true);
      }
      put(wrap, body);
    } else { st.openGroups.delete(key); body.remove(); }
    tog.textContent = on ? '▾' : '▸';
  };
  row.addEventListener('click', (ev) => {
    if (ev.target.closest('button, .chip') || String(window.getSelection?.() ?? '')) return;
    open(!st.openGroups.has(key));
  });
  if (st.openGroups.has(key)) open(true);
  return wrap;
}

// ---------- final object synthesis ----------

const TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed', 'response.done']);

/**
 * Returns { value, note } for a response: the parsed JSON body, the terminal
 * Responses object, or an object rebuilt from Messages / Chat stream events.
 */
export function finalObject(resp) {
  if (!resp) return null;
  const events = parseEvents(resp);
  if (!events) {
    const r = tryJson(resp.body?.text);
    return r.ok ? { value: r.value, note: null } : { value: resp.body?.text ?? '', note: '正文不是 JSON，显示原文' };
  }
  const data = events.filter((e) => e.json && typeof e.json === 'object');
  if (data.some((e) => typeof e.json.type === 'string' && e.json.type.startsWith('response.'))) return fromResponses(data);
  if (data.some((e) => e.json.type === 'message_start')) return fromMessages(data);
  if (data.some((e) => Array.isArray(e.json.choices))) return fromChat(data);
  return { value: data.map((e) => e.json), note: '无法识别的事件格式：显示全部事件的 data' };
}

function fromResponses(data) {
  for (let k = data.length - 1; k >= 0; k--) {
    const j = data[k].json;
    if (TERMINAL.has(j.type) && j.response) return { value: j.response, note: `取自终止事件 ${j.type}（#${data[k].i}）的 response 对象` };
  }
  const created = data.find((e) => e.json.type === 'response.created')?.json.response ?? {};
  const output = data.filter((e) => e.json.type === 'response.output_item.done').map((e) => e.json.item);
  const errors = data.filter((e) => e.json.type === 'error').map((e) => e.json);
  return { value: { ...created, output, ...(errors.length ? { errors } : {}) }, note: '流没有终止事件：由 response.created 与 output_item.done 合成' };
}

function fromMessages(data) {
  let msg = {};
  const blocks = [];
  const partial = new Map();
  const extra = [];
  for (const { json: j } of data) {
    if (j.type === 'message_start') msg = structuredClone(j.message ?? {});
    else if (j.type === 'content_block_start') blocks[j.index] = structuredClone(j.content_block ?? {});
    else if (j.type === 'content_block_delta') {
      const b = (blocks[j.index] ??= {});
      const d = j.delta ?? {};
      if (d.type === 'text_delta') b.text = (b.text ?? '') + d.text;
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
      else if (d.type === 'input_json_delta') partial.set(j.index, (partial.get(j.index) ?? '') + d.partial_json);
      else extra.push(j);
    } else if (j.type === 'content_block_stop') {
      if (partial.has(j.index)) {
        const r = tryJson(partial.get(j.index));
        blocks[j.index].input = r.ok ? r.value : partial.get(j.index);
      }
    } else if (j.type === 'message_delta') {
      Object.assign(msg, j.delta ?? {});
      if (j.usage) msg.usage = { ...(msg.usage ?? {}), ...j.usage };
    } else if (!['message_stop', 'ping'].includes(j.type)) extra.push(j);
  }
  for (const [i, s] of partial) if (blocks[i] && blocks[i].input === undefined) blocks[i].input = s;
  msg.content = blocks;
  if (extra.length) msg['(其他事件)'] = extra;
  return { value: msg, note: '由 Messages SSE 事件合成（message_start + content_block_* + message_delta）' };
}

function fromChat(data) {
  const out = {};
  const choices = [];
  for (const { json: j } of data) {
    for (const k of ['id', 'object', 'created', 'model', 'system_fingerprint']) if (j[k] != null && out[k] == null) out[k] = j[k];
    if (j.usage) out.usage = j.usage;
    for (const c of j.choices ?? []) {
      const ch = (choices[c.index ?? 0] ??= { index: c.index ?? 0, message: {}, finish_reason: null });
      const m = ch.message;
      const d = c.delta ?? c.message ?? {};
      for (const [k, v] of Object.entries(d)) {
        if (k === 'tool_calls' && Array.isArray(v)) {
          m.tool_calls ??= [];
          for (const tc of v) {
            const t = (m.tool_calls[tc.index ?? 0] ??= { function: { arguments: '' } });
            if (tc.id) t.id = tc.id;
            if (tc.type) t.type = tc.type;
            if (tc.function?.name) t.function.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') t.function.arguments += tc.function.arguments;
          }
        } else if (typeof v === 'string' && (k === 'content' || k === 'reasoning_content')) m[k] = (m[k] ?? '') + v;
        else if (v != null) m[k] = v;
      }
      if (c.finish_reason) ch.finish_reason = c.finish_reason;
    }
  }
  out.object = 'chat.completion（由 chunk 合成）';
  out.choices = choices;
  return { value: out, note: '由 Chat SSE chunk 合成（delta 按 choice/tool_call 合并）' };
}
