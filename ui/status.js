// Display transport outcomes independently from diagnostics about model output.
import { parseEvents } from './events.js';
import { tryJson } from './dom.js';

export const OUTCOME_CLASS = { active: 'info', completed: 'ok', incomplete: 'warn', failed: 'bad', error: 'bad', aborted: 'warn' };

export function responseFailure(resp, error) {
  if (resp?.failure) return resp.failure;
  if ((resp?.status ?? 0) >= 400) return { kind: 'http', message: resp.error ?? `HTTP ${resp.status}` };
  // Older exports lack classified failures. Preserve their explicit protocol and
  // transport errors instead of interpreting a cancelled socket as success.
  if (resp && !Object.hasOwn(resp, 'failure')) {
    const events = parseEvents(resp);
    const json = events ? events.map(e => e.json) : [tryJson(resp.body?.text).value];
    const failed = json.find(j => j && (j.type === 'error' || j.type === 'response.failed' || j.status === 'failed' || j.error));
    if (failed) return { kind: 'protocol', message: failed.error?.message ?? failed.response?.error?.message ?? failed.message ?? '上游报告失败' };
  }
  if (resp?.end === 'error' || error) return { kind: 'transport', message: error ?? resp.error };
  return null;
}

export function responseClass(resp, error) {
  if (responseFailure(resp, error)) return 'bad';
  if (!resp) return 'dim';
  if (resp.end === 'active') return 'info';
  if (resp.end === 'cancelled') return 'warn';
  return resp.status ? 'ok' : 'dim';
}

export function exchangeClass(exchange) {
  if ((exchange.status ?? 0) >= 400 || responseFailure(exchange.client?.response)) return 'bad';
  return OUTCOME_CLASS[exchange.outcome] ?? 'dim';
}

/** Full captures contain protocol evidence that older call summaries omit. */
export function upstreamCalls(exchange) {
  if (!Array.isArray(exchange.upstream)) return exchange.upstream_calls ?? [];
  return exchange.upstream.map(call => ({
    ...call.response, label: call.label,
    error: call.error ?? call.response?.error,
    end: call.response?.end ?? (call.error ? 'error' : null),
    failure: responseFailure(call.response, call.error),
  }));
}

export function needsAttention(exchange) {
  if (['failed', 'error', 'aborted', 'incomplete'].includes(exchange.outcome) || exchangeClass(exchange) === 'bad' || exchange.tool_error_count > 0) return true;
  return upstreamCalls(exchange).some(c => responseClass(c) === 'bad' || c.end === 'cancelled');
}
