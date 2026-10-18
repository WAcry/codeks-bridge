// Inspector controller: polling the bridge, offline import, top bar, list and detail wiring.
import { h, btn, fill, download, fmtBytes, fmtDateTime, toast } from './dom.js';
import { api, ApiError, getToken, setToken, parseExport, exportDoc, stamp } from './api.js';
import { ExchangeList, FILTER_CHIPS, byNewest } from './list.js';
import { DetailView } from './detail.js';

const POLL_MS = 1500;
const ACTIVE_DETAIL_MS = 2000;
const DETAIL_CACHE = 8;
const PREFS_KEY = 'codeks-inspector-prefs';

const $ = (id) => document.getElementById(id);

// ---------- preferences ----------

const prefs = Object.assign({ listW: 440, group: false, chips: {}, keepalive: false, merge: true, modes: {}, pane: 'req' },
  (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {}; } catch { return {}; } })());
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage full or disabled */ } };

// ---------- store ----------

const store = {
  mode: 'live',          // 'live' | 'offline'
  offline: null,         // {name, exported_at}
  state: null,
  rev: 0,
  startedAt: null,
  map: new Map(),        // id -> Summary (offline: Detail)
  cache: new Map(),      // id -> {rev, detail, at}
  selected: null,
  selectToken: 0,
  conn: 'connecting',    // 'ok' | 'down' | 'auth' | 'forbidden' | 'connecting'
  connError: '',
  timer: null,
  busy: false,
  authOpen: false,
};

const list = new ExchangeList($('list'), $('list-info'), { onSelect: (id) => select(id) });
list.rerender = () => renderList();

const detail = new DetailView($('detail'), {
  prefs,
  savePrefs,
  live: () => store.mode === 'live',
  summaries: () => store.map,
  summary: (id) => store.map.get(id) ?? store.cache.get(id)?.detail ?? null,
  getDetail: (id) => getDetail(id),
  refresh: () => refreshSelected(true),
});

// ---------- data access ----------

async function getDetail(id, fresh = false) {
  if (store.mode === 'offline') {
    const d = store.map.get(id);
    if (!d) throw new Error(`导入文件中没有记录 ${id}`);
    return d;
  }
  const sum = store.map.get(id);
  const hit = store.cache.get(id);
  if (hit && !fresh && (!sum || (sum.rev === hit.rev && !sum.active))) {
    store.cache.delete(id);
    store.cache.set(id, hit);
    return hit.detail;
  }
  if (hit && !sum && !fresh) return hit.detail;
  const d = await api(`exchanges/${encodeURIComponent(id)}`);
  store.cache.delete(id);
  store.cache.set(id, { rev: d.rev, detail: d, at: Date.now() });
  while (store.cache.size > DETAIL_CACHE) {
    const oldest = [...store.cache.keys()].find((k) => k !== store.selected);
    store.cache.delete(oldest);
  }
  return d;
}

async function select(id, { scroll = false } = {}) {
  if (!id) return;
  store.selected = id;
  list.setSelected(id);
  if (scroll) list.scrollToSelected();
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  const token = ++store.selectToken;
  const cached = store.mode === 'offline' ? store.map.get(id) : store.cache.get(id)?.detail;
  if (cached && cached.id === id) detail.show(cached, { gone: store.mode === 'live' && !store.map.has(id) });
  else detail.clear('加载中…');
  try {
    const d = await getDetail(id);
    if (token !== store.selectToken) return;
    detail.show(d, { gone: store.mode === 'live' && !store.map.has(id) });
  } catch (e) {
    if (token !== store.selectToken) return;
    if (e instanceof ApiError && e.status === 404) detail.clear('这条记录已被清空或淘汰（bridge 上已不存在）。');
    else if (e instanceof ApiError && e.status === 401) { detail.clear('需要令牌'); askToken(); }
    else detail.clear(`加载失败：${e.message}`);
  }
}

/** Re-fetches the selected exchange when it changed or is still streaming. */
async function refreshSelected(force = false) {
  const id = store.selected;
  if (!id || store.mode !== 'live') return;
  const sum = store.map.get(id);
  const hit = store.cache.get(id);
  if (!sum) { if (detail.detail?.id === id && !detail.gone) detail.show(detail.detail, { gone: true }); return; }
  const stale = !hit || hit.rev !== sum.rev || (sum.active && Date.now() - hit.at >= ACTIVE_DETAIL_MS) || (hit.detail.active && !sum.active);
  if (!force && !stale) return;
  try {
    const d = await getDetail(id, true);
    if (store.selected === id) detail.show(d);
    if (force) toast('已刷新');
  } catch (e) {
    if (force) toast(`刷新失败：${e.message}`, true);
  }
}

// ---------- polling ----------

function schedule(ms = POLL_MS) {
  clearTimeout(store.timer);
  store.timer = null;
  if (store.mode !== 'live' || document.hidden || store.authOpen) return;
  store.timer = setTimeout(tick, ms);
}

async function tick() {
  if (store.busy) return;
  store.busy = true;
  let next = POLL_MS;
  try {
    const st = await api('state');
    if (store.mode !== 'live') return;
    if (store.startedAt != null && st.started_at !== store.startedAt) resetLive('bridge 已重启，记录已重置');
    store.startedAt = st.started_at;
    store.state = st;
    if (st.rev !== store.rev || store.rev === 0) {
      const r = await api(`exchanges?since=${store.rev}`);
      if (store.mode !== 'live') return;
      applyList(r);
    }
    setConn('ok');
    renderTop();
    await refreshSelected();
  } catch (e) {
    next = handleError(e);
  } finally {
    store.busy = false;
    schedule(next);
  }
}

function applyList(r) {
  const ids = new Set(r.ids ?? []);
  if (r.rev < store.rev) { resetLive(); }
  for (const s of r.exchanges ?? []) store.map.set(s.id, s);
  for (const id of [...store.map.keys()]) if (!ids.has(id)) store.map.delete(id);
  // Unknown ids mean a missed update (e.g. after a reset): resync from scratch next tick.
  const missing = [...ids].some((id) => !store.map.has(id));
  store.rev = missing ? 0 : r.rev;
  renderList();
  if (!store.selected && store.map.size) {
    const want = decodeURIComponent(location.hash.slice(1));
    const first = store.map.has(want) ? want : [...store.map.values()].sort(byNewest)[0].id;
    select(first, { scroll: true });
  }
}

function resetLive(message) {
  store.map.clear();
  store.cache.clear();
  store.rev = 0;
  if (message) toast(message);
}

function handleError(e) {
  if (!(e instanceof ApiError)) { console.error(e); setConn('down', String(e.message || e)); return 5000; }
  if (e.status === 401) { setConn('auth'); askToken(getToken() ? '令牌无效，请重新输入' : ''); return POLL_MS; }
  if (e.status === 403) { setConn('forbidden', e.message); return 5000; }
  setConn('down', e.message);
  return e.status === 0 ? 5000 : 3000;
}

function setConn(conn, message = '') {
  const changed = store.conn !== conn;
  store.conn = conn;
  store.connError = message;
  renderTop();
  if (changed && !store.map.size) renderList(); // refresh the empty-list hint
  const banner = $('banner');
  const show = (...nodes) => { fill(banner, ...nodes); banner.hidden = false; };
  if (store.mode === 'offline') { banner.hidden = true; return; }
  if (conn === 'down') show(`无法连接 bridge API（${message}），稍后自动重试。也可以点击“导入”离线查看导出文件。`);
  else if (conn === 'forbidden') show('403：bridge 没有配置 inspector 令牌时，只接受从 loopback 地址（如 127.0.0.1）同源打开的页面。请改用本机地址打开，或在 bridge 上配置令牌。', h('span', { class: 'dim' }, ` ${message}`));
  else if (conn === 'auth' && !store.authOpen) show('需要访问令牌。', btn('输入令牌', () => askToken()));
  else banner.hidden = true;
}

// ---------- auth ----------

function askToken(error = '') {
  const dlg = $('token-dialog');
  $('token-error').textContent = error;
  $('token-error').hidden = !error;
  if (dlg.open) return;
  store.authOpen = true;
  clearTimeout(store.timer);
  $('token-input').value = '';
  dlg.showModal();
  $('token-input').focus();
}

$('token-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('token-input').value.trim();
  if (!value) return;
  setToken(value);
  store.authOpen = false;
  $('token-dialog').close();
  tick();
});
$('token-cancel').addEventListener('click', () => $('token-dialog').close());
$('token-dialog').addEventListener('close', () => {
  if (store.authOpen) { store.authOpen = false; setConn('auth'); }
});

// ---------- top bar ----------

function renderTop() {
  const st = store.state;
  const offline = store.mode === 'offline';
  const conn = $('conn');
  const set = (text, cls, title = '') => { conn.textContent = text; conn.className = `chip ${cls}`; conn.title = title; };
  if (offline) set(`离线 · ${store.offline.name}`, 'warn', `导出于 ${fmtDateTime(store.offline.exported_at)} · ${store.map.size} 条记录`);
  else if (store.conn === 'ok') set('● 已连接', 'ok', st ? `bridge 启动于 ${fmtDateTime(st.started_at)}` : '');
  else if (store.conn === 'auth') set('需要令牌', 'warn');
  else if (store.conn === 'forbidden') set('403 禁止访问', 'bad', store.connError);
  else if (store.conn === 'down') set('未连接', 'bad', store.connError);
  else set('连接中…', 'dim');

  const cap = $('capture');
  const capturing = !offline && !!st?.capturing;
  cap.disabled = offline || !st;
  cap.textContent = capturing ? '■ 停止捕获' : '● 开始捕获';
  cap.classList.toggle('on', capturing);
  cap.title = capturing ? '正在捕获新请求；点击停止（已存储的记录保留）' : '当前未捕获；点击开始捕获新请求';
  document.body.classList.toggle('capturing', capturing);
  $('clear').disabled = offline || !st;
  $('live').hidden = !offline;
  fill($('mem'), ...memNodes(st, offline));
  $('models').hidden = offline || !st?.models?.length;
}

function memNodes(st, offline) {
  if (offline) return [h('span', { class: 'dim' }, `${store.map.size} 条记录`)];
  if (!st) return [];
  const meter = h('meter', { min: 0, max: st.max_bytes || 1, value: st.bytes, low: (st.max_bytes || 1) * 0.7, high: (st.max_bytes || 1) * 0.9, optimum: 0 });
  return [h('span', { title: '存储的近似大小 / 上限（超过后淘汰最早的已结束记录）' }, `内存 ${fmtBytes(st.bytes)} / ${fmtBytes(st.max_bytes)}`), meter,
    h('span', { class: 'dim' }, `${st.exchanges} 条 · 进行中 ${st.active}${st.evicted ? ` · 已淘汰 ${st.evicted}` : ''}`)];
}

function renderModels() {
  const models = store.state?.models ?? [];
  const cols = [...new Set(models.flatMap((m) => Object.keys(m)))];
  $('models-body').replaceChildren(h('table', { class: 'calls' },
    h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))),
    h('tbody', null, models.map((m) => h('tr', { class: 'clickable', title: '按此别名筛选', onclick: () => { setFilter(m.alias ?? ''); $('models').open = false; } },
      cols.map((c) => h('td', { class: 'mono' }, typeof m[c] === 'object' && m[c] !== null ? JSON.stringify(m[c]) : String(m[c] ?? '–'))))))));
}
$('models').addEventListener('toggle', () => { if ($('models').open) renderModels(); });

$('capture').addEventListener('click', async () => {
  try {
    store.state = await api('capture', { method: 'POST', json: { enabled: !store.state?.capturing } });
    renderTop();
    toast(store.state.capturing ? '已开始捕获' : '已停止捕获（已存储的记录保留）');
  } catch (e) { handleError(e); toast(`操作失败：${e.message}`, true); }
});

$('clear').addEventListener('click', async () => {
  if (!confirm('删除 bridge 上所有已捕获的记录？')) return;
  try {
    store.state = await api('exchanges', { method: 'DELETE' });
    resetLive();
    store.selected = null;
    detail.clear('已清空。');
    renderList();
    renderTop();
    tick();
  } catch (e) { handleError(e); toast(`清空失败：${e.message}`, true); }
});

$('export-all').addEventListener('click', async () => {
  try {
    if (store.mode === 'offline') {
      download(`codeks-bridge-capture-${stamp()}.json`, JSON.stringify(exportDoc([...store.map.values()].sort(byNewest).reverse())));
      return;
    }
    toast('正在导出…');
    const res = await api('export', { raw: true });
    const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `codeks-bridge-capture-${stamp()}.json`;
    download(name, await res.blob());
  } catch (e) { handleError(e); toast(`导出失败：${e.message}`, true); }
});

// ---------- import / offline ----------

$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) importFile(file);
});

async function importFile(file) {
  try {
    const doc = parseExport(await file.text());
    enterOffline(doc, file.name);
    toast(`已导入 ${doc.exchanges.length} 条记录（离线查看）`);
  } catch (e) {
    toast(`导入失败：${e.message}`, true);
  }
}

function enterOffline(doc, name) {
  store.mode = 'offline';
  clearTimeout(store.timer);
  store.offline = { name, exported_at: doc.exported_at };
  store.map = new Map(doc.exchanges.filter((d) => d && d.id != null).map((d) => [String(d.id), d]));
  store.cache.clear();
  store.selected = null;
  $('banner').hidden = true;
  renderTop();
  renderList();
  const first = [...store.map.values()].sort(byNewest)[0];
  if (first) select(first.id, { scroll: true });
  else detail.clear('导入文件里没有记录。');
}

$('live').addEventListener('click', () => {
  store.mode = 'live';
  store.offline = null;
  store.map = new Map();
  store.rev = 0;
  store.selected = null;
  detail.clear('正在连接 bridge…');
  renderTop();
  renderList();
  tick();
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('drop').hidden = false; } });
document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const file = e.dataTransfer.files[0];
  if (file) importFile(file);
});

// ---------- list, filter and chips ----------

function emptyText() {
  if (store.mode === 'offline') return '导入文件里没有记录';
  if (!store.state) return { connecting: '连接中…', auth: '需要访问令牌（见上方提示）', forbidden: '403 禁止访问（见上方提示）', down: '无法连接 bridge（见上方提示）' }[store.conn] ?? '无法读取 bridge 状态';
  return store.state.capturing ? '正在捕获，等待 codeks 发来请求…' : '尚未开始捕获。点击上方“● 开始捕获”，然后在 codeks 中继续对话。';
}

function renderList() {
  list.render(store.map, { filter: $('filter').value, chips: prefs.chips, group: prefs.group, empty: emptyText() });
  if (!store.selected && !store.map.size) detail.clear(store.mode === 'offline' ? '导入文件里没有记录。' : '在左侧选择一条记录。');
}

function setFilter(text) {
  $('filter').value = text;
  renderList();
}

$('filter').addEventListener('input', () => renderList());
$('filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { setFilter(''); $('filter').blur(); }
  if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); $('list').focus(); select(list.neighbor(0) ?? list.order[0], { scroll: true }); }
});

for (const [key, label, title] of FILTER_CHIPS) {
  const b = h('button', { type: 'button', class: `btn toggle${prefs.chips[key] ? ' on' : ''}`, title }, label);
  b.addEventListener('click', () => {
    prefs.chips[key] = !prefs.chips[key];
    b.classList.toggle('on', prefs.chips[key]);
    savePrefs();
    renderList();
  });
  $('chips').append(b);
}

$('group').classList.toggle('on', prefs.group);
$('group').addEventListener('click', () => {
  prefs.group = !prefs.group;
  $('group').classList.toggle('on', prefs.group);
  savePrefs();
  renderList();
  list.scrollToSelected();
});

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, dialog, [contenteditable]')) return;
  if (e.key === '/') { e.preventDefault(); $('filter').focus(); $('filter').select(); return; }
  const delta = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 }[e.key];
  if (delta && (e.target === document.body || e.target.closest?.('#list, .list-pane'))) {
    e.preventDefault();
    const id = list.neighbor(delta);
    if (id && id !== store.selected) select(id, { scroll: true });
  }
});

// ---------- splitter ----------

const main = $('main');
const applyWidth = () => main.style.setProperty('--list-w', `${prefs.listW}px`);
applyWidth();
$('splitter').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const sp = $('splitter');
  sp.setPointerCapture(e.pointerId);
  const move = (ev) => {
    prefs.listW = Math.round(Math.max(240, Math.min(window.innerWidth * 0.7, ev.clientX - main.getBoundingClientRect().left)));
    applyWidth();
  };
  const up = () => { sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); savePrefs(); };
  sp.addEventListener('pointermove', move);
  sp.addEventListener('pointerup', up);
});

// ---------- start ----------

document.addEventListener('visibilitychange', () => {
  if (store.mode !== 'live') return;
  if (document.hidden) clearTimeout(store.timer);
  else tick();
});
window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && id !== store.selected && store.map.has(id)) select(id, { scroll: true });
});

$('boot')?.remove();
detail.clear('正在连接 bridge…');
renderTop();
renderList();
tick();
