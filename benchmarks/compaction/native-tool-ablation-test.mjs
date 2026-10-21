import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Run explicitly with node; all requests go to a local fake server.
const runner = fileURLToPath(new URL('./native-tool-ablation.mjs', import.meta.url));
const base = await readFile(new URL('./prompts/base-instructions.txt', import.meta.url), 'utf8');
const message = (role, text) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
const conditions = ['legacy', 'legacy-plus-tools'];
const checkpoint = { type: 'compaction', id: 'cmp_synthetic', encrypted_content: 'synthetic-checkpoint' };
const generatedReasoning = { type: 'reasoning', id: 'rs_synthetic', summary: [],
  encrypted_content: 'GENERATED_REASONING_MUST_NOT_BE_REPLAYED' };
const fixture = {
  id: 'native-tools-fixture', metadata: { seed: 2 },
  thread: [message('user', 'Recorded value: synthetic-answer.'), message('assistant', 'Recorded.')],
  retained: [message('user', 'RETAINED_MUST_NOT_BE_REPLAYED')],
  tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
  quiz: 'Return JSON answers for known and unknown. Use null for unrecorded values.',
  questions: [
    { id: 'known', question: 'What value was recorded?', expected: 'synthetic-answer', category: 'recall',
      evidence: 'GOLD_EVIDENCE_MUST_NOT_BE_SENT' },
    { id: 'unknown', question: 'What is unrecorded?', expected: null, category: 'unknown' },
  ],
};
const toolsItem = { type: 'additional_tools', role: 'developer', tools: fixture.tools };
const common = { model: 'fixture-model', stream: true, store: false,
  include: ['reasoning.encrypted_content'], parallel_tool_calls: false };
const usage = { input_tokens: 100, output_tokens: 12, total_tokens: 112,
  input_tokens_details: { cached_tokens: 25 }, output_tokens_details: { reasoning_tokens: 4 } };
const secret = 'synthetic-private-header-value';
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function setup(t, { seed = 2, sse = false, failAt = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-tool-ablation-'));
  const fixturePath = join(root, 'fixture.json');
  await writeFile(fixturePath, JSON.stringify({ ...fixture, metadata: { seed } }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, headers: req.headers });
    if (requests.length === failAt) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Synthetic unavailable response.' } }));
      return;
    }
    const native = body.input.at(-1)?.type === 'compaction_trigger';
    const output = native ? [generatedReasoning, checkpoint] : [{ type: 'message', role: 'assistant',
      id: 'msg_synthetic', status: 'completed', content: [{ type: 'output_text',
        text: JSON.stringify({ known: 'synthetic-answer', unknown: null }), annotations: [] }] }];
    const response = { id: `resp_synthetic_${requests.length}`, object: 'response', status: 'completed', output, usage };
    res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
    res.end(sse ? `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`
      : JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const out = join(root, 'out');
  async function run(args = [], overrides = {}) {
    const child = spawn(process.execPath, [runner, '--fixture', fixturePath,
      '--model', 'fixture-model', '--out', out, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, BENCHMARK_URL: `http://127.0.0.1:${server.address().port}/responses`,
      BENCHMARK_HEADERS: JSON.stringify({ authorization: `Bearer ${secret}`, 'x-test-private-header': secret }),
      ...overrides,
    } });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  }
  return { root, out, requests, run, order: seed % 2 ? [...conditions].reverse() : conditions };
}

async function assertPrivateTree(path) {
  const info = await stat(path);
  assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600, path);
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await assertPrivateTree(join(path, name));
  } else {
    const contents = await readFile(path, 'utf8');
    assert.ok(!contents.includes(secret), `credentials saved in ${path}`);
    assert.ok(!contents.includes('x-test-private-header'), `headers saved in ${path}`);
  }
}

for (const seed of [2, 3]) {
  test(`seed ${seed}: offline plan ignores endpoint and credentials and creates nothing`, async t => {
    const state = await setup(t, { seed });
    const result = await state.run([], { BENCHMARK_URL: 'invalid URL', BENCHMARK_HEADERS: 'invalid JSON' });
    assert.equal(result.code, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(plan.conditions, conditions);
    assert.deepEqual(plan.order, state.order);
    assert.equal(plan.request_count, 4);
    assert.equal(state.requests.length, 0);
    assert.deepEqual(await readdir(state.root), ['fixture.json']);
    await assert.rejects(stat(state.out), { code: 'ENOENT' });
  });

  test(`seed ${seed}: exact native requests and identical isolated readers`, async t => {
    const state = await setup(t, { seed, sse: seed % 2 === 1 });
    const result = await state.run(['--execute']);
    assert.equal(result.code, 0, result.stderr);
    const manifest = await json(join(state.out, 'manifest.json'));
    const results = await json(join(state.out, 'results.json'));
    assert.equal(manifest.status, 'completed');
    assert.deepEqual(manifest.conditions, conditions);
    assert.deepEqual(manifest.order, state.order);
    assert.equal(results.fixture_id, fixture.id);
    assert.equal(results.model, 'fixture-model');
    assert.deepEqual(results.conditions, conditions);
    assert.deepEqual(results.stages.map(stage => stage.id), state.order);
    assert.deepEqual(results.quizzes.map(quiz => quiz.id), state.order);
    assert.deepEqual(results.failed_requests, []);
    assert.equal(state.requests.length, 4);
    const readerKeys = [];
    for (const [index, condition] of state.order.entries()) {
      const generation = state.requests[index * 2].body;
      assert.deepEqual(generation, { ...common,
        input: [...(condition === 'legacy-plus-tools' ? [toolsItem] : []), message('developer', base),
          ...fixture.thread, { type: 'compaction_trigger' }],
        reasoning: { effort: 'medium', context: 'all_turns' }, text: { verbosity: 'low' }, tool_choice: 'auto' });
      const { prompt_cache_key: key, ...reader } = state.requests[index * 2 + 1].body;
      assert.equal(typeof key, 'string');
      assert.ok(key.length > 0);
      readerKeys.push(key);
      assert.deepEqual(reader, { ...common,
        input: [toolsItem, message('developer', base), checkpoint, message('user', fixture.quiz)],
        reasoning: { effort: 'medium', summary: 'auto', context: 'all_turns' }, tool_choice: 'none' });
      const stage = results.stages[index], quiz = results.quizzes[index];
      assert.deepEqual((await json(join(state.out, stage.artifact))).checkpoint, checkpoint);
      assert.equal(stage.metrics.status, 'completed');
      assert.equal(quiz.metrics.status, 'completed');
      assert.deepEqual(quiz.score.total, { correct: 2, total: 2, accuracy: 1 });
    }
    assert.equal(new Set(readerKeys).size, 2);
    const folders = (await readdir(join(state.out, 'requests'))).sort();
    assert.equal(folders.length, 4);
    for (const [index, folder] of folders.entries()) {
      const directory = join(state.out, 'requests', folder);
      assert.deepEqual(await json(join(directory, 'request.json')), state.requests[index].body);
      assert.equal((await json(join(directory, 'metrics.json'))).status, 'completed');
      assert.equal(state.requests[index].headers.authorization, `Bearer ${secret}`);
    }
    await assertPrivateTree(state.out);
    const reuse = await state.run(['--execute']);
    assert.notEqual(reuse.code, 0, 'existing output must be rejected');
    assert.equal(state.requests.length, 4);
    assert.deepEqual(await json(join(state.out, 'manifest.json')), manifest);
  });
}

test('a later request failure persists completed work and does not retry', async t => {
  const state = await setup(t, { failAt: 4 });
  const result = await state.run(['--execute']);
  assert.notEqual(result.code, 0);
  assert.equal(state.requests.length, 4);
  assert.equal((await json(join(state.out, 'manifest.json'))).status, 'failed');
  const results = await json(join(state.out, 'results.json'));
  assert.deepEqual(results.stages.map(stage => stage.id), conditions);
  assert.deepEqual(results.quizzes.map(quiz => quiz.id), ['legacy']);
  assert.equal(results.failed_requests.length, 1);
  assert.equal(results.failed_requests[0].metrics.status, 'failed');
  for (const stage of results.stages) {
    assert.equal(stage.metrics.status, 'completed');
    assert.deepEqual((await json(join(state.out, stage.artifact))).checkpoint, checkpoint);
  }
  const folders = (await readdir(join(state.out, 'requests'))).sort();
  assert.equal(folders.length, 4);
  const failed = join(state.out, 'requests', folders.at(-1));
  assert.equal((await json(join(failed, 'metrics.json'))).status, 'failed');
  assert.ok((await readFile(join(failed, 'error.txt'), 'utf8')).length > 0);
  await assertPrivateTree(state.out);
});
