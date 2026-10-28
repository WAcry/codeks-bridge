#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { request } from './run.mjs';
import { score } from './score.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value, null, 2) + '\n';
const save = (path, value) => writeFile(path, typeof value === 'string' ? value : json(value), { mode: 0o600 });
const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const timestamp = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'long',
}).format(new Date());
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);

/** Remove only a single complete outer JSON code fence; never change answer values. */
export function answerContent(text) {
  return text.trim().match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/)?.[1] ?? text;
}

function repositoryPath(path, root) {
  if (typeof path !== 'string' || isAbsolute(path)) throw new Error('Inputs must use repository-relative paths');
  const absolute = resolve(root, path);
  if (relative(root, absolute).startsWith('..')) throw new Error(`Input escapes the repository: ${path}`);
  return absolute;
}

/** Prepare and verify every selected byte without reading credentials or using the network. */
export async function prepare(planPath, selected, root = repository) {
  const bytes = await readFile(resolve(planPath));
  const plan = JSON.parse(bytes);
  if (!object(plan) || typeof plan.model !== 'string' || !plan.model || !object(plan.request_options)
      || !Array.isArray(plan.prompts) || !plan.prompts.length || !Array.isArray(plan.cases) || !plan.cases.length
      || !Array.isArray(plan.inputs)) throw new Error('Invalid comparison plan');
  for (const [items, kind] of [[plan.prompts, 'prompt'], [plan.cases, 'case']]) {
    if (items.some(item => !object(item) || !identifier(item.id))
        || new Set(items.map(item => item.id)).size !== items.length) throw new Error(`Invalid or duplicate ${kind} id`);
  }
  for (const key of ['model', 'input', 'instructions', 'tools', 'previous_response_id', 'conversation',
    'prompt', 'prompt_cache_key', 'stream', 'store']) {
    if (Object.hasOwn(plan.request_options, key)) throw new Error(`request_options cannot set ${key}`);
  }
  const controls = plan.controls ?? ['full', 'empty'];
  if (!Array.isArray(controls) || new Set(controls).size !== controls.length
      || controls.some(name => !['full', 'empty'].includes(name))) throw new Error('Invalid controls');
  const concurrency = plan.case_concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid case_concurrency');
  const cases = plan.cases.filter(item => !selected || selected.includes(item.id));
  if (!cases.length || selected?.some(id => !cases.some(item => item.id === id))) throw new Error('Unknown or empty --cases selection');
  const expected = new Map();
  for (const input of plan.inputs) {
    if (!object(input) || typeof input.path !== 'string' || expected.has(input.path)
        || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 0) {
      throw new Error('Invalid or duplicate input manifest entry');
    }
    expected.set(input.path, input);
  }
  const sources = new Map();
  const load = async path => {
    if (sources.has(path)) return sources.get(path);
    const definition = expected.get(path);
    if (!definition) throw new Error(`Missing input hash: ${path}`);
    const value = await readFile(repositoryPath(path, root));
    if (value.length !== definition.bytes || hash(value) !== definition.sha256) throw new Error(`Input hash mismatch: ${path}`);
    sources.set(path, value);
    return value;
  };
  const instructions = (await load(plan.base_instructions)).toString('utf8');
  const summaryPrefix = (await load(plan.summary_prefix)).toString('utf8');
  const prompts = await Promise.all(plan.prompts.map(async item => ({ ...item, text: (await load(item.path)).toString('utf8') })));
  if (prompts.some(item => !item.text.trim())) throw new Error('A summary prompt is empty');
  const preparedCases = [];
  for (const item of cases) {
    const fixtureBytes = await load(item.fixture);
    const fixture = JSON.parse(fixtureBytes);
    const questionsBytes = item.questions ? await load(item.questions) : fixtureBytes;
    const questionnaire = JSON.parse(questionsBytes);
    if (typeof fixture.id !== 'string' || !Array.isArray(fixture.thread) || !Array.isArray(fixture.tools)
        || (questionnaire.fixture_id !== undefined && questionnaire.fixture_id !== fixture.id)) throw new Error(`Invalid fixture: ${item.id}`);
    const { quiz, questions } = questionnaire;
    if (typeof quiz !== 'string' || !quiz.trim() || !Array.isArray(questions) || !questions.length
        || questions.some(q => !object(q) || typeof q.id !== 'string' || !q.id || typeof q.question !== 'string'
          || !Object.hasOwn(q, 'expected') || (q.unordered !== undefined && typeof q.unordered !== 'boolean')
          || (q.unordered === true && !Array.isArray(q.expected)))
        || new Set(questions.map(q => q.id)).size !== questions.length) throw new Error(`Invalid questions: ${item.id}`);
    const prefix = [
      ...(fixture.tools.length ? [{ type: 'additional_tools', role: 'developer', tools: fixture.tools }] : []),
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] },
    ];
    const index = plan.cases.findIndex(candidate => candidate.id === item.id);
    const orderedPrompts = index % 2 ? [...prompts].reverse() : prompts;
    preparedCases.push({ ...item, prefix, full: [...prefix, ...fixture.thread], quiz, questions,
      baselineKey: hash(Buffer.concat([fixtureBytes, questionsBytes])),
      promptOrder: orderedPrompts.map(prompt => prompt.id), index });
  }
  return { plan, planBytes: bytes, cases: preparedCases, prompts, sources, summaryPrefix, controls, concurrency };
}

/** Execute independent text-summary routes. Model retries belong to the caller, not this runner. */
export async function execute(data, out, { url = process.env.BENCHMARK_URL, headers: configuredHeaders } = {}) {
  if (!url) throw new Error('Missing BENCHMARK_URL');
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.pathname.endsWith('/responses')) {
    throw new Error('BENCHMARK_URL must be a complete Responses endpoint');
  }
  configuredHeaders ??= JSON.parse(process.env.BENCHMARK_HEADERS ?? '{}');
  if (!object(configuredHeaders) || Object.values(configuredHeaders).some(value => typeof value !== 'string')) {
    throw new Error('BENCHMARK_HEADERS must be an object of strings');
  }
  const headers = new Headers(configuredHeaders);
  headers.set('content-type', 'application/json');
  headers.set('x-openai-internal-codex-responses-lite', 'true');
  out = resolve(out);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await mkdir(out, { mode: 0o700 });
  for (const name of ['requests', 'snapshots', 'products']) await mkdir(join(out, name), { mode: 0o700 });
  await save(join(out, 'snapshots/plan.json'), data.planBytes.toString('utf8'));
  const snapshotIndex = [];
  for (const [path, bytes] of data.sources) {
    const snapshot = `snapshots/input-${String(snapshotIndex.length + 1).padStart(3, '0')}`;
    await writeFile(join(out, snapshot), bytes, { mode: 0o600 });
    snapshotIndex.push({ path, snapshot, sha256: hash(bytes), bytes: bytes.length });
  }
  const results = { model: data.plan.model, request_options: data.plan.request_options,
    started_at: timestamp(), timezone: 'America/Los_Angeles', node_version: process.version,
    status: 'running', selected_cases: data.cases.map(item => item.id), snapshots: snapshotIndex,
    baselines: [], cases: [], requests: [], failures: [] };
  let persistence = Promise.resolve();
  const persist = () => {
    const snapshot = json(results);
    persistence = persistence.then(() => save(join(out, 'results.json'), snapshot));
    return persistence;
  };
  const bodyFor = input => ({ ...data.plan.request_options, model: data.plan.model, input, stream: true, store: false });
  const log = value => console.log(JSON.stringify(value));
  let sequence = 0;
  const call = async (sample, stage, body, kind, prompt) => {
    const label = `${String(++sequence).padStart(3, '0')}-${sample.id}-${stage}`;
    const record = { case: sample.id, stage, ...(prompt ? { prompt } : {}), request: label,
      request_sha256: hash(JSON.stringify(body)) };
    log({ case: sample.id, stage, prompt, status: 'started' });
    try {
      const output = await request(url, headers, out, label, body, kind);
      Object.assign(record, { metrics: output.metrics, text_artifact: `requests/${label}/text.txt` });
      if (kind !== 'summary') {
        const content = answerContent(output.text);
        record.score_strict = score(output.text, sample.questions);
        record.score_content = score(content, sample.questions);
        record.outer_code_fence_removed = content !== output.text;
      }
      results.requests.push(record);
      log({ case: sample.id, stage, prompt, status: 'completed',
        input_tokens: record.metrics.input_tokens, cached_tokens: record.metrics.cached_tokens,
        output_tokens: record.metrics.output_tokens, product_tokens: record.metrics.product_output_tokens,
        known: record.score_content?.known, strict_known: record.score_strict?.known });
      await persist();
      return { ...record, text: output.text };
    } catch (error) {
      Object.assign(record, { metrics: error.request_metrics ?? { status: 'failed', kind },
        error_artifact: `requests/${label}/error.txt` });
      results.requests.push(record);
      results.failures.push({ case: sample.id, stage, prompt, request: label });
      log({ case: sample.id, stage, prompt, status: 'failed', request: label });
      await persist();
      return record;
    }
  };
  const baselines = new Map();
  const baselineFor = sample => {
    if (!baselines.has(sample.baselineKey)) baselines.set(sample.baselineKey, (async () => {
      const record = { id: sample.id, fixture: sample.fixture, stages: {} };
      results.baselines.push(record);
      // Establish the complete, unchanged history prefix before requesting summaries.
      for (const control of data.controls) {
        const body = { ...bodyFor([...(control === 'full' ? sample.full : sample.prefix), user(sample.quiz)]),
          tool_choice: control === 'full' ? 'auto' : 'none' };
        const { text, ...stage } = await call(sample, `control-${control}`, body, 'control');
        record.stages[control] = stage;
      }
      await persist();
      return record;
    })());
    return baselines.get(sample.baselineKey);
  };
  const runCase = async sample => {
    const baseline = await baselineFor(sample);
    const record = { id: sample.id, group: sample.group, fixture: sample.fixture,
      baseline_case: baseline.id, prompt_order: sample.promptOrder, routes: {} };
    results.cases.push(record);
    for (const id of sample.promptOrder) {
      const prompt = data.prompts.find(item => item.id === id);
      const route = record.routes[id] = {};
      const { text, ...generation } = await call(sample, `generate-${id}`,
        bodyFor([...sample.full, user(prompt.text)]), 'summary', id);
      route.generation = generation;
      if (generation.metrics.status !== 'completed') continue;
      const artifact = `products/${sample.id}-${id}.txt`;
      await save(join(out, artifact), text);
      route.product = { artifact, sha256: hash(text), utf8_bytes: Buffer.byteLength(text),
        characters: [...text].length, output_tokens: generation.metrics.product_output_tokens,
        output_tokens_source: generation.metrics.product_output_tokens_source };
    }
    // Keep both long-prefix generation calls adjacent before starting closed-book recovery.
    for (const id of sample.promptOrder) {
      const route = record.routes[id];
      if (!route.product) continue;
      const text = await readFile(join(out, route.product.artifact), 'utf8');
      const body = { ...bodyFor([...sample.prefix, user(data.summaryPrefix + '\n\n' + text), user(sample.quiz)]),
        tool_choice: 'none' };
      const { text: answer, ...quiz } = await call(sample, `quiz-${id}`, body, 'recovery', id);
      route.quiz = quiz;
      const empty = baseline.stages.empty;
      route.replay_input_tokens = quiz.metrics.status === 'completed' && empty?.metrics.status === 'completed'
        ? quiz.metrics.input_tokens - empty.metrics.input_tokens : null;
    }
    await persist();
  };
  let cursor = 0;
  try {
    await persist();
    await Promise.all(Array.from({ length: Math.min(data.concurrency, data.cases.length) }, async () => {
      while (cursor < data.cases.length) await runCase(data.cases[cursor++]);
    }));
    results.cases.sort((a, b) => data.cases.findIndex(item => item.id === a.id) - data.cases.findIndex(item => item.id === b.id));
    results.status = results.failures.length ? 'completed_with_failures' : 'completed';
  } finally {
    results.finished_at = timestamp();
    await persist();
  }
  return results;
}

async function main() {
  const { values } = parseArgs({ options: {
    plan: { type: 'string' }, out: { type: 'string' }, cases: { type: 'string' },
    execute: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('node benchmarks/compaction/compare-prompts.mjs --plan FILE --out NEW_DIR [--cases a,b] [--execute]\n'
      + 'Without --execute: verify inputs and print the offline plan. Credentials: BENCHMARK_URL / BENCHMARK_HEADERS.');
    return;
  }
  if (!values.plan || !values.out) throw new Error('Both --plan and --out are required');
  const selected = values.cases?.split(',');
  if (selected && new Set(selected).size !== selected.length) throw new Error('Duplicate --cases selection');
  const data = await prepare(values.plan, selected);
  const fixtures = new Set(data.cases.map(sample => sample.baselineKey));
  console.log(JSON.stringify({ model: data.plan.model, request_options: data.plan.request_options,
    cases: data.cases.map(sample => ({ id: sample.id, fixture: sample.fixture, questions: sample.questions.length,
      prompt_order: sample.promptOrder })), prompts: data.plan.prompts, controls: data.controls,
    case_concurrency: data.concurrency,
    planned_requests: fixtures.size * data.controls.length + data.cases.length * data.prompts.length * 2,
    out: resolve(values.out), execute: values.execute }));
  if (values.execute) await execute(data, values.out);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
