#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { request } from './run.mjs';
import { score } from './score.mjs';

// Manual two-condition experiment. Each condition gets one generation and one recovery.
const here = dirname(fileURLToPath(import.meta.url));
const conditions = ['legacy', 'legacy-plus-tools'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha256(JSON.stringify(value));
const save = (path, value) => writeFile(path,
  typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const message = (role, text) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
const timestamp = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'long',
}).format(new Date());

async function main() {
  const { values: args } = parseArgs({ options: {
    fixture: { type: 'string' }, model: { type: 'string' }, out: { type: 'string' },
    execute: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (args.help) {
    console.log('node benchmarks/compaction/native-tool-ablation.mjs --fixture FILE --model NAME --out NEW_DIR [--execute]\n'
      + 'Without --execute: offline plan only; no credentials, network, or files.\n'
      + 'Execution uses BENCHMARK_URL and BENCHMARK_HEADERS and makes four requests with no retries.\n'
      + 'Even fixture.metadata.seed: legacy first; odd: legacy-plus-tools first.');
    return;
  }
  for (const name of ['fixture', 'model', 'out']) if (!args[name]) throw new Error(`Missing --${name}`);
  const fixtureBytes = await readFile(resolve(args.fixture));
  const fixture = JSON.parse(fixtureBytes);
  if (!object(fixture) || typeof fixture.id !== 'string' || !fixture.id
      || !Array.isArray(fixture.thread) || !Array.isArray(fixture.tools) || !fixture.tools.length
      || !Number.isSafeInteger(fixture.metadata?.seed) || fixture.metadata.seed < 0) {
    throw new Error('Fixture requires id, thread, nonempty tools, and a nonnegative integer metadata.seed');
  }
  const { quiz, questions } = fixture;
  if (typeof quiz !== 'string' || !quiz.trim() || !Array.isArray(questions) || !questions.length
      || questions.some(q => !object(q) || typeof q.id !== 'string' || !q.id
        || typeof q.question !== 'string' || !q.question.trim() || !Object.hasOwn(q, 'expected')
        || (q.unordered !== undefined && typeof q.unordered !== 'boolean')
        || (q.unordered === true && !Array.isArray(q.expected)))
      || new Set(questions.map(q => q.id)).size !== questions.length) {
    throw new Error('Fixture requires quiz text and valid questions with unique ids and expected JSON values');
  }
  const instructions = await readFile(join(here, 'prompts/base-instructions.txt'), 'utf8');
  const tools = { type: 'additional_tools', role: 'developer', tools: fixture.tools };
  const developer = message('developer', instructions);
  const prefix = [tools, developer];
  const generationOptions = {
    model: args.model, stream: true, store: false,
    include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium', context: 'all_turns' },
    text: { verbosity: 'low' }, parallel_tool_calls: false, tool_choice: 'auto',
  };
  const readerOptions = {
    model: args.model, stream: true, store: false,
    include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium', summary: 'auto', context: 'all_turns' },
    parallel_tool_calls: false, tool_choice: 'none',
  };
  const generationBodies = Object.fromEntries(conditions.map(id => [id, {
    ...generationOptions,
    input: [...(id === 'legacy-plus-tools' ? [tools] : []), developer, ...fixture.thread, { type: 'compaction_trigger' }],
  }]));
  const order = fixture.metadata.seed % 2 === 0 ? [...conditions] : [...conditions].reverse();
  const hashes = {
    fixture: sha256(fixtureBytes), thread: digest(fixture.thread), tools: digest(fixture.tools),
    quiz: sha256(quiz), questions: digest(questions), instructions: sha256(instructions),
    reader_prefix: digest(prefix),
    generation_bodies: Object.fromEntries(conditions.map(id => [id, digest(generationBodies[id])])),
  };
  const plan = {
    experiment: 'native-tool-ablation', fixture_id: fixture.id, seed: fixture.metadata.seed, model: args.model,
    conditions, order, request_count: 4, retries: 0, question_count: questions.length,
    generation_request_options: generationOptions, reader_request_options: readerOptions,
    generation_difference: 'legacy-plus-tools prepends exactly one additional_tools item to legacy input',
    recovery_context: 'same additional_tools + developer prefix, only the generated checkpoint, and the same quiz',
    reader_cache_key: 'independent random UUID per request',
    snapshots: { fixture: 'snapshots/fixture.json', instructions: 'snapshots/base-instructions.txt',
      reader_prefix: 'snapshots/reader-prefix.json' },
    hashes, output: resolve(args.out), execute: args.execute,
  };
  console.log(JSON.stringify(plan));
  if (!args.execute) return;

  // Credentials are read only after execution is explicitly selected and are never persisted.
  const url = process.env.BENCHMARK_URL;
  if (!url) throw new Error('Missing environment variable BENCHMARK_URL');
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new Error('BENCHMARK_URL must be a valid HTTP(S) URL'); }
  if (!['https:', 'http:'].includes(parsedUrl.protocol) || !parsedUrl.pathname.endsWith('/responses')) {
    throw new Error('BENCHMARK_URL must be a complete HTTP(S) Responses Lite /responses endpoint');
  }
  let configuredHeaders;
  try { configuredHeaders = JSON.parse(process.env.BENCHMARK_HEADERS ?? '{}'); }
  catch { throw new Error('BENCHMARK_HEADERS must be valid JSON'); }
  if (!object(configuredHeaders) || Object.values(configuredHeaders).some(value => typeof value !== 'string')) {
    throw new Error('BENCHMARK_HEADERS must be a JSON object of strings');
  }
  const headers = new Headers(configuredHeaders);
  headers.set('content-type', 'application/json');
  headers.set('x-openai-internal-codex-responses-lite', 'true');
  const out = resolve(args.out);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await mkdir(out, { mode: 0o700 });
  for (const name of ['requests', 'snapshots', 'products']) await mkdir(join(out, name), { mode: 0o700 });
  const manifest = { ...plan, status: 'running', started_at: timestamp(), timezone: 'America/Los_Angeles',
    node_version: process.version, requests: [] };
  const results = { fixture_id: fixture.id, model: args.model, conditions, stages: [], quizzes: [], failed_requests: [] };
  const persist = async () => {
    await save(join(out, 'manifest.json'), manifest);
    await save(join(out, 'results.json'), results);
  };
  await persist();
  let number = 0;
  const call = async (id, body, kind) => {
    const label = `${String(++number).padStart(3, '0')}-${id}`;
    manifest.requests.push({ label, kind, sha256: digest(body), body: `requests/${label}/request.json` });
    await persist();
    return request(url, headers, out, label, body, kind);
  };
  try {
    await save(join(out, plan.snapshots.fixture), fixtureBytes.toString('utf8'));
    await save(join(out, plan.snapshots.instructions), instructions);
    await save(join(out, plan.snapshots.reader_prefix), prefix);
    for (const id of order) {
      const generated = await call(`generate-${id}`, generationBodies[id], 'native');
      const artifact = `products/${id}.json`;
      await save(join(out, artifact), { id, kind: 'native', checkpoint: generated.checkpoint });
      results.stages.push({ id, artifact, metrics: generated.metrics });
      await persist();
      console.log(JSON.stringify({ completed: `generate-${id}`, metrics: generated.metrics }));
      const reader = await call(`quiz-${id}`, { ...readerOptions, prompt_cache_key: randomUUID(),
        input: [...prefix, generated.checkpoint, message('user', quiz)] }, 'recovery');
      const evaluation = score(reader.text, questions);
      results.quizzes.push({ id, metrics: reader.metrics, score: evaluation });
      await persist();
      console.log(JSON.stringify({ completed: `quiz-${id}`, metrics: reader.metrics, score: evaluation.total }));
    }
    manifest.status = 'completed';
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = error.message;
    if (error.request_metrics) results.failed_requests.push({ id: error.label, metrics: error.request_metrics });
    throw error;
  } finally {
    manifest.finished_at = timestamp();
    await persist();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
