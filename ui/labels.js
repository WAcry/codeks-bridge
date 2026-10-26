// Chinese labels and annotation rendering shared by the views.
import { h, kvTable, shortId, strBlock, put } from './dom.js';
import { jsonTree } from './tree.js';

export const CALL_LABEL = { main: '主请求', summary: '压缩·文字摘要', native: '压缩·原生', handoff: '压缩·交接复述', search: '独立搜索', image_generation: '图片生成' };
export const callLabel = (l) => CALL_LABEL[l] ?? l;

export const INPUT_TRANSFORMATION_LABEL = {
  thinking_dropped: '已丢弃 thinking',
  thinking_mismatch_allowed: '允许失配，保留 thinking',
};

export const KIND_LABEL = { turn: '轮次', compaction: '压缩', search: '独立搜索', image_generation: '图片生成', invalid: '无效' };
export const OUTCOME_LABEL = { active: '进行中', completed: '完成', incomplete: '未完成', failed: '失败', error: '错误', aborted: '中止' };
export const END_LABEL = { active: '传输中', complete: '完整', cancelled: '已取消', error: '出错', unread: '终止事件后停止读取' };

const DECISION = { replay: '回放', passthrough: '原样透传', drop: '丢弃', native: '恢复原生', summary: '文字摘要', handoff: '按需文字交接', reject: '拒绝', output: '输出' };
const DECISION_CLASS = { replay: 'ok', passthrough: 'info', native: 'ok', drop: 'warn', summary: 'warn', handoff: 'warn', reject: 'bad', output: 'info' };
// Verb shown before the reason text, per decision.
const VERB = { replay: '回放', passthrough: '原样透传', drop: '丢弃', reject: '拒绝', summary: '使用文字摘要', handoff: '获取文字交接', native: '恢复原生压缩' };

const REASON = {
  reasoning: {
    same_source: '同一来源',
    allowed_source: '来源在 replay 白名单内',
    source_not_allowed: '来源未在 replay 白名单',
    format_mismatch: '载荷格式与目标不匹配',
    unrecognized_state: '无法识别为 bridge reasoning 载荷，按 replay.unrecognized 处理',
  },
  compaction: {
    native_restored: '',
    no_native: '',
    native_replay_disabled: '目标关闭了 native_replay',
    source_not_allowed: '来源未在原生压缩白名单',
    format_mismatch: '原生格式与目标不匹配',
    unrecognized_state: '无法识别为 bridge 压缩检查点，按 replay.unrecognized 处理',
  },
};

export const KIND_TEXT = { reasoning: 'reasoning', compaction: '压缩' };

export function reasonText(a) {
  if (a.decision === 'output' || a.reason === 'output') return '输出：bridge 生成的载荷';
  const verb = VERB[a.decision] ?? DECISION[a.decision] ?? a.decision ?? '?';
  const why = REASON[a.kind]?.[a.reason];
  if (why === '') return verb;
  return `${verb}：${why ?? a.reason ?? '未知原因'}`;
}

export const decisionText = (d) => DECISION[d] ?? d ?? '–';
export const decisionClass = (d) => DECISION_CLASS[d] ?? 'info';

export function sourceText(src) {
  if (!src) return '';
  const who = src.aliases?.length ? src.aliases.join('/') : src.model ?? shortId(src.origin_id) ?? '?';
  return `来源 ${who}${src.adapter ? ` (${src.adapter})` : ''}`;
}

export function annChip(a, onClick) {
  const source = a.source ? sourceText(a.source)
    : (a.decision === 'output' || (a.kind === 'compaction' && a.reason === 'no_native') ? null : '来源未知');
  const parts = [KIND_TEXT[a.kind] ?? a.kind, source, reasonText(a)].filter(Boolean);
  return h('span', {
    class: `chip ann ${decisionClass(a.decision)}${onClick ? ' click' : ''}`,
    title: `${a.target}${a.event != null ? ` 事件 #${a.event}` : ''} ${a.pointer ?? ''}\n原因代码：${a.reason}\n格式：${a.format ?? '–'}`,
    onclick: onClick ? (e) => { e.stopPropagation(); onClick(a, e); } : null,
  }, parts.join(' · '));
}

/** Full annotation card: fields, compaction summary text and decoded carrier tree. */
export function annDetail(a) {
  const src = a.source;
  const rows = [
    ['位置', `${a.target}${a.event != null ? ` · 事件 #${a.event}` : ''} · ${a.pointer ?? '–'}`],
    ['类型', KIND_TEXT[a.kind] ?? a.kind],
    ['决定', h('span', { class: `chip ${decisionClass(a.decision)}` }, decisionText(a.decision))],
    ['原因', `${reasonText(a)}（${a.reason}）`],
    ['来源', src ? kvTable(Object.entries(src).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '–')])) : '–'],
    ['格式', a.format ?? '–'],
  ];
  for (const [k, v] of Object.entries(a)) {
    if (!['target', 'event', 'pointer', 'kind', 'decision', 'reason', 'source', 'format', 'decoded'].includes(k)) rows.push([k, JSON.stringify(v)]);
  }
  const box = h('div', { class: 'ann-detail' }, kvTable(rows));
  const summary = a.decoded?.summary;
  if (typeof summary === 'string') put(box, h('div', { class: 'sub-title' }, '文字摘要（decoded.summary）'), strBlock(summary, { name: 'summary' }));
  if (a.decoded != null) put(box, h('div', { class: 'sub-title' }, '解码后的完整载荷（decoded）'), jsonTree(a.decoded, { auto: 3 }));
  return box;
}

/** Maps annotations of one target to row indexes, keyed by the first pointer segment(s). */
export function annIndex(anns, target) {
  const byPointer = new Map();
  const byEvent = new Map();
  for (const a of anns || []) {
    if (a.target !== target) continue;
    if (target === 'client.response' && a.event != null) push(byEvent, a.event, a);
    else if (a.pointer != null) push(byPointer, a.pointer, a);
  }
  return { byPointer, byEvent };
}

function push(map, k, v) {
  const list = map.get(k);
  if (list) list.push(v); else map.set(k, [v]);
}
