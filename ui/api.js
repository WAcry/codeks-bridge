// Access to the inspector API (/inspect/api/*) and to imported export files.
// URLs are relative, so the page works under /inspect/ on any host.

const TOKEN_KEY = 'codeks-inspector-token';
export const EXPORT_FORMAT = 'codeks-bridge-capture';

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY));

/** Calls the API. Throws ApiError (status 0 = network failure). */
export async function api(path, { method = 'GET', json, raw = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(`api/${path}`, { method, headers, body, cache: 'no-store', credentials: 'same-origin' });
  } catch (e) {
    throw new ApiError(0, `无法连接 bridge：${e.message || e}`);
  }
  if (!res.ok) {
    let code = null;
    let message = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      code = j?.error?.code ?? null;
      if (j?.error?.message) message = `${res.status}：${j.error.message}`;
    } catch { /* not JSON */ }
    throw new ApiError(res.status, message, code);
  }
  return raw ? res : res.json();
}

/** Validates an export file and returns its exchanges (Detail objects). */
export function parseExport(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`不是 JSON 文件：${e.message}`); }
  if (data?.format !== EXPORT_FORMAT) throw new Error(`不是 ${EXPORT_FORMAT} 导出文件（format=${JSON.stringify(data?.format)}）`);
  if (data.version !== 1) throw new Error(`不支持的导出版本 ${JSON.stringify(data.version)}（支持 1）`);
  if (!Array.isArray(data.exchanges)) throw new Error('导出文件缺少 exchanges 数组');
  return data;
}

export const exportDoc = (exchanges) => ({ format: EXPORT_FORMAT, version: 1, exported_at: Date.now(), exchanges });

/** Local file name stamp: YYYYMMDD-HHMMSS. */
export function stamp(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
