#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseJsonSse } from '../../src/sse.ts';
import { score } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const definitions = {
  K1: { kind: 'summary', source: 'full history', prompt: 'builtin' },
  K2: { kind: 'summary', source: 'full history', prompt: 'claude-code' },
  K3: { kind: 'native', source: 'full history', trigger: 'compaction_trigger' },
  K4: { kind: 'handoff', source: 'retained U + the same K3', prompt: 'handoff', dependency: 'K3' },
};
const promptNames = ['builtin', 'claude-code', 'handoff', 'summary-prefix'];
const defaultOptions = {
  reasoning: { effort: 'medium', summary: 'auto', context: 'all_turns' },
  tool_choice: 'auto', parallel_tool_calls: false, include: ['reasoning.encrypted_content'],
};
const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const sha256 = data => createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const save = (path, value) => writeFile(path, typeof value === 'string' ? value : json(value), { mode: 0o600 });
const timestamp = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'long',
}).format(new Date());
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function select(value, allowed, option) {
  const selected = value.split(',');
  if (new Set(selected).size !== selected.length || selected.some(id => !allowed.includes(id))) {
    throw new Error(`Invalid or duplicate --${option}`);
  }
  return selected;
}

function argumentsFor(argv) {
  const strings = ['fixture', 'questions', 'out', 'model', 'url-env', 'headers-env', 'options',
    'instructions', 'products', 'controls', 'reuse-products'];
  const { values } = parseArgs({ args: argv, options: {
    ...Object.fromEntries(strings.map(name => [name, { type: 'string' }])),
    execute: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('node benchmarks/compaction/run.mjs --fixture FILE --out NEW_DIR --model NAME\n'
      + '  [--questions FILE] [--products K1,K2,K3,K4] [--controls empty,full|none]\n'
      + '  [--instructions FILE] [--options JSON_FILE] [--reuse-products RUN_DIR]\n'
      + '  [--url-env BENCHMARK_URL] [--headers-env BENCHMARK_HEADERS] [--execute]\n'
      + 'Without --execute: offline plan only. All products and both controls are selected by default.\n'
      + 'Product quizzes use only their K plus the recorded constant prefix. K4 requires fixture.retained.\n'
      + 'The URL must be a full Responses Lite /responses endpoint.');
    return null;
  }
  for (const name of ['fixture', 'out', 'model']) if (!values[name]) throw new Error(`Missing --${name}`);
  values.products = select(values.products ?? 'K1,K2,K3,K4', Object.keys(definitions), 'products');
  values.controls = values.controls === 'none' ? [] : select(values.controls ?? 'empty,full', ['empty', 'full'], 'controls');
  values['url-env'] ??= 'BENCHMARK_URL';
  values['headers-env'] ??= 'BENCHMARK_HEADERS';
  return values;
}

async function reuseProducts(directory, plan, hashes) {
  const run = resolve(directory);
  const manifestBytes = await readFile(join(run, 'manifest.json'));
  const source = JSON.parse(manifestBytes);
  const results = JSON.parse(await readFile(join(run, 'results.json'), 'utf8'));
  for (const [name, expected] of Object.entries({ model: plan.model, fixture_id: plan.fixture_id,
    definitions: plan.definitions, constant_prefix: plan.constant_prefix, request_options: plan.request_options, hashes })) {
    if (JSON.stringify(source[name]) !== JSON.stringify(expected)) {
      throw new Error(`Reuse source does not match current ${name}`);
    }
  }
  if (results.model !== plan.model || results.fixture_id !== plan.fixture_id || !Array.isArray(results.stages)) {
    throw new Error('Reuse source results do not match the current plan');
  }
  const reused = [];
  for (const id of plan.stages) {
    const stages = results.stages.filter(stage => stage.id === id);
    if (stages.length !== 1 || stages[0].metrics?.status !== 'completed'
        || stages[0].metrics.kind !== definitions[id].kind) {
      throw new Error(`Reuse source has no completed generation for ${id}`);
    }
    const artifact = `products/${id}.json`;
    const bytes = await readFile(join(run, artifact));
    const product = JSON.parse(bytes);
    if (!object(product) || product.id !== id || product.kind !== (id === 'K3' ? 'native' : 'text')
        || (id === 'K3' ? !object(product.checkpoint)
          || !['compaction', 'compaction_summary'].includes(product.checkpoint.type)
          || typeof product.checkpoint.encrypted_content !== 'string' || !product.checkpoint.encrypted_content
          : typeof product.text !== 'string' || !product.text.trim())) {
      throw new Error(`Reuse source has an invalid ${id} product`);
    }
    reused.push({ product, stage: { id, artifact, metrics: stages[0].metrics, reused: true,
      source: { run, artifact, sha256: sha256(bytes) } } });
  }
  const native = reused.find(({ product }) => product.id === 'K3')?.product;
  const handoff = reused.find(({ product }) => product.id === 'K4')?.product;
  if (handoff && handoff.native_dependency_sha256 !== sha256(JSON.stringify(native.checkpoint))) {
    throw new Error('Reuse source K4 does not depend on the same K3');
  }
  plan.reuse_products = { run, manifest_sha256: sha256(manifestBytes) };
  return reused;
}

async function prepare(args) {
  const fixtureBytes = await readFile(resolve(args.fixture));
  const fixture = JSON.parse(fixtureBytes);
  if (!object(fixture) || typeof fixture.id !== 'string' || !Array.isArray(fixture.thread) || !Array.isArray(fixture.tools)) {
    throw new Error('Fixture requires id, thread, and tools');
  }
  if (fixture.retained !== undefined && (!Array.isArray(fixture.retained)
      || fixture.retained.some(item => !object(item) || item.role !== 'user'))) {
    throw new Error('retained must contain only user items');
  }
  if (args.products.includes('K4') && !Array.isArray(fixture.retained)) {
    throw new Error('K4 requires fixture.retained; generate the fixture with --retained-tokens');
  }
  const questionsBytes = args.questions ? await readFile(resolve(args.questions)) : null;
  const questionnaire = questionsBytes ? JSON.parse(questionsBytes) : fixture;
  if (!object(questionnaire) || (questionnaire.fixture_id !== undefined && questionnaire.fixture_id !== fixture.id)) {
    throw new Error('Questionnaire fixture_id must match the fixture');
  }
  const { quiz, questions } = questionnaire;
  if (typeof quiz !== 'string' || !quiz.trim() || !Array.isArray(questions) || !questions.length
      || questions.some(q => !object(q) || typeof q.id !== 'string' || !q.id
        || typeof q.question !== 'string' || !q.question.trim() || !Object.hasOwn(q, 'expected')
        || (q.unordered !== undefined && typeof q.unordered !== 'boolean')
        || (q.unordered === true && !Array.isArray(q.expected)))
      || new Set(questions.map(q => q.id)).size !== questions.length) {
    throw new Error('Supply quiz text and questions with unique ids, question text, and expected JSON values');
  }
  const instructions = await readFile(resolve(args.instructions ?? join(here, 'prompts/base-instructions.txt')), 'utf8');
  const prompts = Object.fromEntries(await Promise.all(promptNames.map(async name =>
    [name, await readFile(join(here, `prompts/${name}.txt`), 'utf8')])));
  const options = args.options ? JSON.parse(await readFile(resolve(args.options), 'utf8')) : {};
  if (!object(options)) throw new Error('options must be a JSON object');
  // Context and request identity are owned by this benchmark, including every recovery request.
  for (const key of ['model', 'input', 'instructions', 'tools', 'previous_response_id', 'conversation',
    'prompt', 'prompt_cache_key', 'stream', 'store']) {
    if (Object.hasOwn(options, key)) throw new Error(`options cannot set ${key}`);
  }
  const effectiveOptions = { ...defaultOptions, ...options };
  // Only this fixed prefix can be shared by recovery calls. Task-specific history stays in the fixture thread.
  const prefix = [
    ...(fixture.tools.length ? [{ type: 'additional_tools', role: 'developer', tools: fixture.tools }] : []),
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] }];
  const full = [...prefix, ...fixture.thread];
  const stages = Object.keys(definitions).filter(id => args.products.includes(id) || (id === 'K3' && args.products.includes('K4')));
  const quizzes = [...args.controls.map(id => `control-${id}`), ...args.products];
  const hashes = { fixture: sha256(fixtureBytes), questions: sha256(JSON.stringify(questions)), quiz: sha256(quiz),
    instructions: sha256(instructions), options: sha256(JSON.stringify(effectiveOptions)),
    prompts: Object.fromEntries(Object.entries(prompts).map(([name, value]) => [name, sha256(value)])) };
  const plan = {
    fixture_id: fixture.id, model: args.model, products: args.products, definitions,
    stages, quizzes, request_count: (args['reuse-products'] ? 0 : stages.length) + quizzes.length,
    recovery_context: 'constant prefix + only the selected K + quiz; text K uses the constant summary-prefix wrapper',
    controls: args.controls, question_count: questions.length,
    questionnaire_source: args.questions ? resolve(args.questions) : resolve(args.fixture),
    constant_prefix: { item_count: prefix.length, sha256: sha256(JSON.stringify(prefix)),
      snapshot: 'snapshots/prefix.json', text_wrapper: 'snapshots/summary-prefix.txt' },
    request_options: effectiveOptions, recovery_request_options: { ...effectiveOptions, tool_choice: 'none' },
    output: resolve(args.out), execute: args.execute,
  };
  const reused = args['reuse-products'] ? await reuseProducts(args['reuse-products'], plan, hashes) : [];
  return { fixture, fixtureBytes, questionsBytes, quiz, questions, instructions, prompts, options, effectiveOptions,
    full, prefix, plan, hashes, reused };
}

function metrics(usage, outputItems, kind) {
  const count = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Missing or invalid usage.${name}`);
    return value;
  };
  const input = count(usage?.input_tokens, 'input_tokens');
  const output = count(usage?.output_tokens, 'output_tokens');
  const total = count(usage?.total_tokens, 'total_tokens');
  const cached = usage.input_tokens_details == null ? null : count(usage.input_tokens_details.cached_tokens, 'input_tokens_details.cached_tokens');
  const reasoning = usage.output_tokens_details == null ? null : count(usage.output_tokens_details.reasoning_tokens, 'output_tokens_details.reasoning_tokens');
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens == null ? null
    : count(usage.input_tokens_details.cache_write_tokens, 'input_tokens_details.cache_write_tokens');
  const budget = usage.codex_rollout_budget_units ?? null;
  if (budget !== null && !Number.isFinite(budget)) throw new Error('Invalid usage.codex_rollout_budget_units');
  const attributed = usage.attribution?.items;
  const byType = Object.create(null);
  for (const item of outputItems) {
    const itemUsage = attributed?.[item.id];
    if (!object(itemUsage)) continue;
    const totals = byType[item.type] ??= { items: 0 };
    totals.items++;
    for (const key of ['input_tokens', 'cached_tokens', 'cache_write_tokens', 'output_tokens']) {
      const value = itemUsage[key] == null ? null : count(itemUsage[key], `attribution.items.<id>.${key}`);
      totals[key] = value === null || totals[key] === null ? null : (totals[key] ?? 0) + value;
    }
  }
  const productItems = outputItems.filter(item => kind === 'native'
    ? ['compaction', 'compaction_summary'].includes(item.type)
    : item.type === 'message' && item.role === 'assistant');
  const productCounts = productItems.map(item => attributed?.[item.id]?.output_tokens);
  const hasAttribution = productCounts.length > 0 && productCounts.every(value => Number.isSafeInteger(value) && value >= 0);
  return { input_tokens: input, output_tokens: output, total_tokens: total,
    cached_tokens: cached, cache_write_tokens: cacheWrite, reasoning_tokens: reasoning,
    non_reasoning_output_tokens: reasoning === null ? null : output - reasoning,
    output_item_usage_by_type: byType,
    product_output_kind: kind === 'native' ? 'native' : 'text',
    product_output_tokens: hasAttribution ? productCounts.reduce((sum, value) => sum + value, 0)
      : reasoning === null ? null : output - reasoning,
    product_output_tokens_source: hasAttribution ? 'usage.attribution.items'
      : reasoning === null ? 'unavailable' : 'output_tokens minus reasoning_tokens (approximate)',
    codex_rollout_budget_units: budget };
}

function assistantText(output, kind) {
  let messages = output.filter(item => item.type === 'message' && item.role === 'assistant');
  if (['recovery', 'control'].includes(kind) && messages.some(item => item.phase === 'final_answer')) {
    messages = messages.filter(item => item.phase === 'final_answer');
  }
  const parts = messages.flatMap(item => item.content ?? []);
  if (parts.some(part => part.type === 'refusal')) throw new Error('Response was refused');
  const text = parts.filter(part => part.type === 'output_text').map(part => part.text).join('\n').trim();
  if (!text) throw new Error('Response contains no assistant text');
  return text;
}

export async function request(url, headers, out, label, body, kind) {
  const directory = join(out, 'requests', label);
  await mkdir(directory, { mode: 0o700 });
  await save(join(directory, 'request.json'), body);
  await save(join(directory, 'metrics.json'), { status: 'running', kind });
  const start = performance.now();
  let firstEvent = null, terminal, terminalType, httpStatus;
  const items = new Map();
  const timing = () => ({ elapsed_ms: performance.now() - start, first_event_ms: firstEvent });
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' });
    httpStatus = response.status;
    if (!response.ok) {
      await save(join(directory, 'http-error.txt'), await response.text());
      throw new Error(`HTTP ${response.status}`);
    }
    if (response.headers.get('content-type')?.includes('application/json')) {
      terminal = await response.json();
      firstEvent = performance.now() - start;
      terminalType = `response.${terminal.status}`;
    } else {
      if (!response.body) throw new Error('Response body is empty');
      for await (const { event, json: value } of parseJsonSse(response.body)) {
        firstEvent ??= performance.now() - start;
        await appendFile(join(directory, 'events.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 });
        const type = value.type ?? event;
        if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          if (!Number.isSafeInteger(value.output_index) || value.output_index < 0 || !object(value.item)) {
            throw new Error('Invalid output item event');
          }
          items.set(value.output_index, { item: value.item, done: type.endsWith('.done') });
        }
        if (['response.completed', 'response.failed', 'response.incomplete'].includes(type)) {
          terminal = value.response;
          terminalType = type;
          break;
        }
        if (type === 'error') throw new Error('Upstream returned an error event; see events.jsonl');
      }
    }
    if (terminal !== undefined) await save(join(directory, 'response.json'), terminal);
    if (terminalType !== 'response.completed' || terminal?.status !== 'completed' || terminal.error) {
      throw new Error('Response did not finish with response.completed');
    }
    if (typeof terminal.id !== 'string' || (terminal.end_turn != null && typeof terminal.end_turn !== 'boolean')) {
      throw new Error('Invalid response id or end_turn');
    }
    if (terminal.end_turn === false) throw new Error('Response did not end its turn');
    if (terminal.output !== undefined && !Array.isArray(terminal.output)) throw new Error('Invalid terminal output');
    for (const [index, item] of (terminal.output ?? []).entries()) {
      if (!items.get(index)?.done) items.set(index, { item, done: true });
    }
    if ([...items.values()].some(item => !item.done)) throw new Error('Response contains unfinished output items');
    const ordered = [...items.entries()].sort(([a], [b]) => a - b);
    if (ordered.some(([index], position) => index !== position)) throw new Error('Response output items have missing indexes');
    const output = ordered.map(([, state]) => state.item);
    await save(join(directory, 'output.json'), output);
    if (output.some(item => !object(item) || (item.status != null && item.status !== 'completed'))) {
      throw new Error('Response contains invalid or unfinished output items');
    }
    if (output.some(item => item.type?.endsWith('_call') || item.type === 'tool_call')) {
      throw new Error('Response contains a tool call; no tools were executed');
    }
    const usage = metrics(terminal.usage, output, kind);
    let text = '', checkpoint;
    if (kind === 'native') {
      const checkpoints = output.filter(item => ['compaction', 'compaction_summary'].includes(item.type));
      if (checkpoints.length !== 1 || typeof checkpoints[0].encrypted_content !== 'string' || !checkpoints[0].encrypted_content) {
        throw new Error('Native response must contain exactly one nonempty checkpoint');
      }
      checkpoint = checkpoints[0];
    } else text = assistantText(output, kind);
    const result = { status: 'completed', kind, http_status: httpStatus, ...usage,
      usage_metadata: terminal.usage_metadata ?? null, ...timing() };
    await save(join(directory, 'text.txt'), text);
    await save(join(directory, 'metrics.json'), result);
    return { output, text, checkpoint, metrics: result };
  } catch (error) {
    const failed = { status: 'failed', kind, http_status: httpStatus ?? null,
      reported_usage: terminal?.usage ?? null, usage_metadata: terminal?.usage_metadata ?? null, ...timing() };
    await save(join(directory, 'metrics.json'), failed);
    // Raw upstream errors may contain endpoint details and stay in the private run directory.
    await save(join(directory, 'error.txt'), String(error.stack ?? error));
    throw Object.assign(new Error(`${label} failed; inspect its private request directory`), { request_metrics: failed, label });
  }
}

function usageTotals(results) {
  const grouped = {};
  for (const { metrics: value } of [...results.stages.filter(stage => !stage.reused), ...results.quizzes]) {
    const totals = grouped[value.kind] ??= { calls: 0 };
    totals.calls++;
    for (const name of ['input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'cache_write_tokens',
      'reasoning_tokens', 'non_reasoning_output_tokens', 'product_output_tokens', 'codex_rollout_budget_units']) {
      // An absent usage detail remains unknown instead of becoming a fabricated zero.
      totals[name] = value[name] === null || totals[name] === null ? null : (totals[name] ?? 0) + value[name];
    }
  }
  return grouped;
}

async function execute(args, data) {
  const { fixture, fixtureBytes, questionsBytes, quiz, questions, instructions, prompts, options,
    effectiveOptions, full, prefix, plan, hashes, reused } = data;
  // Credentials are read only after the caller explicitly selected execution.
  const url = process.env[args['url-env']];
  if (!url) throw new Error(`Missing environment variable ${args['url-env']}`);
  const parsedUrl = new URL(url);
  if (!['https:', 'http:'].includes(parsedUrl.protocol) || !parsedUrl.pathname.endsWith('/responses')) {
    throw new Error('URL must be a complete HTTP(S) Responses Lite /responses endpoint');
  }
  const configuredHeaders = JSON.parse(process.env[args['headers-env']] ?? '{}');
  if (!object(configuredHeaders) || Object.values(configuredHeaders).some(value => typeof value !== 'string')) {
    throw new Error('Headers must be a JSON object of strings');
  }
  const headers = new Headers(configuredHeaders);
  headers.set('content-type', 'application/json');
  headers.set('x-openai-internal-codex-responses-lite', 'true');
  const out = resolve(args.out);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await mkdir(out, { mode: 0o700 }); // Existing runs are never resumed or overwritten.
  for (const name of ['requests', 'snapshots', 'products']) await mkdir(join(out, name), { mode: 0o700 });
  await save(join(out, 'snapshots/fixture.json'), fixtureBytes.toString('utf8'));
  if (questionsBytes) await save(join(out, 'snapshots/questions.json'), questionsBytes.toString('utf8'));
  await save(join(out, 'snapshots/base-instructions.txt'), instructions);
  await save(join(out, 'snapshots/prefix.json'), prefix);
  for (const [name, prompt] of Object.entries(prompts)) await save(join(out, `snapshots/${name}.txt`), prompt);
  const manifest = { ...plan, status: 'running', started_at: timestamp(), timezone: 'America/Los_Angeles',
    node_version: process.version, url_env: args['url-env'], headers_env: args['headers-env'], options,
    hashes };
  const results = { fixture_id: fixture.id, model: args.model, products: args.products,
    stages: [], quizzes: [], failed_requests: [], completed_usage_by_kind: {},
    cost_note: 'Usage is reported per call and by kind. No token-to-dollar conversion is assumed; native K3 is generated once and shared with K4.' };
  await save(join(out, 'manifest.json'), manifest);
  const persist = async () => {
    results.completed_usage_by_kind = usageTotals(results);
    await save(join(out, 'results.json'), results);
  };
  await persist();
  const bodyFor = input => ({ ...effectiveOptions, model: args.model, input, stream: true, store: false });
  let number = 0;
  const products = new Map();
  const call = (id, body, kind) => request(url, headers, out, `${String(++number).padStart(3, '0')}-${id}`, body, kind);
  const summaryItem = text => user(prompts['summary-prefix'] + '\n\n' + text);
  try {
    for (const { product, stage } of reused) {
      products.set(product.id, product);
      await save(join(out, stage.artifact), product);
      if (product.kind === 'text') await save(join(out, `products/${product.id}.txt`), product.text);
      results.stages.push(stage);
    }
    await persist();
    for (const id of reused.length ? [] : plan.stages) {
      const definition = definitions[id];
      const input = id === 'K3' ? [...full, { type: 'compaction_trigger' }]
        : id === 'K4' ? [...prefix, ...fixture.retained, products.get('K3').checkpoint, user(prompts.handoff)]
          : [...full, user(prompts[definition.prompt])];
      const result = await call(`generate-${id}`, bodyFor(input), definition.kind);
      // The product excludes generation reasoning and all other response items.
      const product = { id, kind: id === 'K3' ? 'native' : 'text',
        ...(id === 'K3' ? { checkpoint: result.checkpoint } : { text: result.text }),
        ...(id === 'K4' ? { native_dependency_sha256: sha256(JSON.stringify(products.get('K3').checkpoint)) } : {}) };
      products.set(id, product);
      await save(join(out, `products/${id}.json`), product);
      if (id !== 'K3') await save(join(out, `products/${id}.txt`), result.text);
      results.stages.push({ id, artifact: `products/${id}.json`, metrics: result.metrics });
      await persist();
      console.log(JSON.stringify({ completed: `generate-${id}`, metrics: result.metrics }));
    }
    for (const id of plan.quizzes) {
      let input;
      if (id === 'control-empty') input = [...prefix, user(quiz)];
      else if (id === 'control-full') input = [...full, user(quiz)];
      else {
        const product = products.get(id);
        input = [...prefix, product.kind === 'native' ? product.checkpoint : summaryItem(product.text), user(quiz)];
      }
      const body = { ...bodyFor(input), tool_choice: 'none', prompt_cache_key: randomUUID() };
      const result = await call(`quiz-${id}`, body, id.startsWith('control-') ? 'control' : 'recovery');
      const evaluation = score(result.text, questions);
      results.quizzes.push({ id, metrics: result.metrics, score: evaluation });
      await persist();
      console.log(JSON.stringify({ completed: `quiz-${id}`, metrics: result.metrics, score: evaluation.total }));
    }
    manifest.status = 'completed';
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = error.message;
    if (error.request_metrics) results.failed_requests.push({ id: error.label, metrics: error.request_metrics });
    await persist();
    throw error;
  } finally {
    manifest.finished_at = timestamp();
    await save(join(out, 'manifest.json'), manifest);
  }
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  if (!args) return;
  const data = await prepare(args);
  console.log(JSON.stringify(data.plan));
  if (args.execute) await execute(args, data);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
