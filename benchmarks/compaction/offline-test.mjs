import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { score } from './score.mjs';

// Run explicitly with node; every upstream in this file is a local fake server.
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const prompt = async name => readFile(new URL(`./prompts/${name}.txt`, import.meta.url), 'utf8');
const prompts = Object.fromEntries(await Promise.all(['builtin', 'claude-code', 'handoff', 'summary-prefix']
  .map(async name => [name, await prompt(name)])));
const message = (role, text) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
const checkpoint = { type: 'compaction', id: 'cmp_offline', encrypted_content: 'synthetic-checkpoint' };
const generationReasoning = { type: 'reasoning', id: 'rs_offline', summary: [],
  encrypted_content: 'GENERATION_REASONING_MUST_STAY_LOCAL' };
const fixture = {
  id: 'offline-fixture',
  thread: [message('user', 'Historical value: secret-answer'), message('assistant', 'Recorded.')],
  retained: [message('user', 'RETAINED_U_MARKER')],
  tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
  quiz: 'Return JSON answers to q-known (recorded value) and q-unknown (unrecorded value). Do not guess.',
  questions: [
    { id: 'q-known', question: 'What value was recorded?', expected: 'secret-answer', category: 'recall',
      evidence: 'GOLD_EVIDENCE_MUST_STAY_LOCAL' },
    { id: 'q-unknown', question: 'What value is unrecorded?', expected: null, category: 'unknown' },
  ],
  facts: [{ statement: 'GOLD_FACTS_MUST_STAY_LOCAL' }],
};
const instructions = 'Use the supplied project history and tools.';
const prefix = [{ type: 'additional_tools', role: 'developer', tools: fixture.tools }, message('developer', instructions)];
const usage = { input_tokens: 100, output_tokens: 12, total_tokens: 112,
  input_tokens_details: { cached_tokens: 25 }, output_tokens_details: { reasoning_tokens: 4 } };
const lastText = body => body.input.at(-1)?.content?.map(part => part.text ?? '').join('') ?? '';
const isNative = body => body.input.at(-1)?.type === 'compaction_trigger';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const summary = id => `SYNTHETIC_${id}: secret-answer`;

async function setup(t, { mode = 'json', fixtureValue = fixture, questionnaire } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'compaction-offline-'));
  const fixturePath = join(root, 'fixture.json');
  const instructionPath = join(root, 'instructions.txt');
  await writeFile(fixturePath, JSON.stringify(fixtureValue));
  await writeFile(instructionPath, instructions);
  const quizText = questionnaire?.quiz ?? fixtureValue.quiz;
  const quizQuestions = questionnaire?.questions ?? fixtureValue.questions;
  const isQuiz = body => lastText(body) === quizText;
  let questionsPath;
  if (questionnaire) {
    questionsPath = join(root, 'questions.json');
    await writeFile(questionsPath, JSON.stringify(questionnaire));
  }
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, headers: req.headers });
    if (mode === 'http-failed' || (mode === 'quiz-failed' && isQuiz(body))) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Synthetic unavailable response.' } }));
      return;
    }
    const id = isNative(body) ? 'K3' : { [prompts.builtin]: 'K1',
      [prompts['claude-code']]: 'K2', [prompts.handoff]: 'K4' }[lastText(body)];
    const text = isQuiz(body) ? JSON.stringify(Object.fromEntries(quizQuestions.map(q => [q.id, q.expected]))) : summary(id);
    let output = isNative(body) ? [generationReasoning, checkpoint] : [generationReasoning,
      { type: 'message', role: 'assistant', id: 'msg_offline', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }] }];
    if (mode === 'quiz-phases' && isQuiz(body)) output = [generationReasoning,
      { type: 'message', role: 'assistant', id: 'msg_commentary', status: 'completed', phase: 'commentary',
        content: [{ type: 'output_text', text: 'Checking the supplied checkpoint.', annotations: [] }] },
      { ...output[1], phase: 'final_answer' }];
    if (mode === 'tool-call' || (mode === 'quiz-tool-call-once' && isQuiz(body)
        && requests.filter(request => isQuiz(request.body)).length === 1)) {
      output = [{ type: 'function_call', name: 'lookup', call_id: 'call_fake', arguments: '{}' }];
    }
    if (mode === 'refused') output = [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Synthetic refusal' }] }];
    if (mode === 'native-missing-ciphertext') output = [{ ...checkpoint, encrypted_content: '' }];
    if (mode === 'native-multiple') output = [checkpoint, { ...checkpoint, id: 'cmp_duplicate' }];
    const attributedUsage = mode === 'attribution' ? { ...usage, attribution: { items: Object.fromEntries(output.map(item =>
      [item.id, { input_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, output_tokens: item.type === 'reasoning' ? 4 : 8 }])) } } : usage;
    const response = { id: `resp_offline_${requests.length}`, object: 'response', status: 'completed', output,
      ...(mode === 'missing-usage' ? {} : { usage: attributedUsage }) };
    if (mode.startsWith('sse-')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      if (mode === 'sse-failed' || mode === 'sse-incomplete') {
        const status = mode.slice(4);
        event({ type: `response.${status}`, response: { ...response, status,
          ...(status === 'failed' ? { error: { code: 'synthetic_failure', message: 'Synthetic failed stream.' } }
            : { incomplete_details: { reason: 'max_output_tokens' } }) } });
      } else {
        if (['sse-item-done', 'sse-no-terminal', 'sse-unfinished'].includes(mode)) {
          for (const [output_index, item] of output.entries()) {
            event({ type: mode === 'sse-unfinished' ? 'response.output_item.added' : 'response.output_item.done', output_index, item });
          }
        }
        if (mode !== 'sse-no-terminal') event({ type: 'response.completed', response: { ...response,
          ...(['sse-item-done', 'sse-unfinished'].includes(mode) ? { output: [] } : {}) } });
      }
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const out = join(root, 'out');
  const env = { ...process.env, BENCHMARK_URL: `http://127.0.0.1:${server.address().port}/responses`,
    BENCHMARK_HEADERS: JSON.stringify({ authorization: 'Bearer synthetic-offline-token' }) };
  async function run(args = [], overrides = {}) {
    const child = spawn(process.execPath, [runner, '--fixture', fixturePath, '--out', out,
      '--model', 'fixture-model', '--url-env', 'BENCHMARK_URL', '--headers-env', 'BENCHMARK_HEADERS',
      '--instructions', instructionPath, ...(questionsPath ? ['--questions', questionsPath] : []), ...args],
    { env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  }
  return { root, out, requests, run, isQuiz, quizText };
}

async function assertPrivateTree(path) {
  const info = await stat(path);
  assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600, path);
  if (info.isDirectory()) for (const name of await readdir(path)) await assertPrivateTree(join(path, name));
}

test('planning uses no credentials, network, or output directory', async t => {
  const state = await setup(t);
  const result = await state.run([], { BENCHMARK_HEADERS: 'invalid JSON', BENCHMARK_URL: '' });
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.products, ['K1', 'K2', 'K3', 'K4']);
  assert.equal(plan.request_count, 10);
  assert.deepEqual(plan.quizzes, ['control-empty', 'control-full', 'K1', 'K2', 'K3', 'K4']);
  assert.equal(state.requests.length, 0);
  await assert.rejects(stat(state.out), { code: 'ENOENT' });
});

for (const mode of ['json', 'sse-item-done', 'sse-terminal-output']) {
  test(`${mode}: exact K1-K4 inputs, one shared K3, and isolated recovery`, async t => {
    const state = await setup(t, { mode });
    const args = ['--execute'];
    if (mode === 'json') {
      const options = join(state.root, 'options.json');
      await writeFile(options, JSON.stringify({ unknown_option: { preserved: true },
        reasoning: { effort: 'high', context: 'all_turns' } }));
      args.push('--options', options);
    }
    const result = await state.run(args);
    assert.equal(result.code, 0, result.stderr);
    const manifest = await json(join(state.out, 'manifest.json'));
    const results = await json(join(state.out, 'results.json'));
    assert.equal(manifest.status, 'completed');
    assert.deepEqual(await json(join(state.out, 'snapshots/prefix.json')), prefix);
    assert.equal(results.stages.filter(stage => stage.metrics.kind === 'native').length, 1);
    assert.equal(results.quizzes.length, 6);
    assert.deepEqual(Object.fromEntries(Object.entries(results.completed_usage_by_kind).map(([kind, value]) => [kind, value.calls])),
      { summary: 2, native: 1, handoff: 1, control: 2, recovery: 4 });
    for (const quiz of results.quizzes) {
      assert.equal(quiz.metrics.status, 'completed');
      assert.equal(quiz.score.total.correct, 2);
      assert.equal(quiz.score.unknown.correct, 1);
    }
    const bodies = state.requests.map(request => request.body);
    assert.equal(bodies.length, 10);
    const generations = bodies.filter(body => !state.isQuiz(body));
    for (const [index, name] of ['builtin', 'claude-code'].entries()) {
      assert.deepEqual(generations[index].input, [...prefix, ...fixture.thread, message('user', prompts[name])]);
    }
    assert.deepEqual(generations[2].input, [...prefix, ...fixture.thread, { type: 'compaction_trigger' }]);
    assert.deepEqual(generations[3].input, [...prefix, ...fixture.retained, checkpoint, message('user', prompts.handoff)]);
    assert.equal(bodies.filter(isNative).length, 1);
    const quizzes = bodies.filter(state.isQuiz);
    assert.equal(new Set(quizzes.map(body => body.prompt_cache_key)).size, quizzes.length);
    const quiz = message('user', fixture.quiz);
    assert.deepEqual(quizzes[0].input, [...prefix, quiz]);
    assert.deepEqual(quizzes[1].input, [...prefix, ...fixture.thread, quiz]);
    for (const [index, id] of ['K1', 'K2', 'K3', 'K4'].entries()) {
      const k = id === 'K3' ? checkpoint : message('user', prompts['summary-prefix'] + '\n\n' + summary(id));
      assert.deepEqual(quizzes[index + 2].input, [...prefix, k, quiz]);
      const product = await json(join(state.out, `products/${id}.json`));
      if (id === 'K3') assert.deepEqual(product.checkpoint, checkpoint);
      else assert.equal(product.text, summary(id));
    }
    for (const body of bodies) {
      const serialized = JSON.stringify(body);
      assert.equal(body.model, 'fixture-model');
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      for (const marker of ['GOLD_EVIDENCE_MUST_STAY_LOCAL', 'GOLD_FACTS_MUST_STAY_LOCAL',
        generationReasoning.encrypted_content, '"expected"', '"evidence"', 'previous_response_id']) {
        assert.ok(!serialized.includes(marker), marker);
      }
      assert.equal(serialized.includes('RETAINED_U_MARKER'), body === generations[3]);
      if (!state.isQuiz(body)) assert.ok(!serialized.includes(fixture.quiz));
      assert.deepEqual(body.input.slice(0, 2), prefix);
      assert.equal(body.tool_choice, state.isQuiz(body) ? 'none' : 'auto');
      assert.deepEqual(body.include, ['reasoning.encrypted_content']);
      assert.equal(body.parallel_tool_calls, false);
      assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
      if (mode === 'json') {
        assert.deepEqual(body.unknown_option, { preserved: true });
        assert.deepEqual(body.reasoning, { effort: 'high', context: 'all_turns' });
      } else assert.deepEqual(body.reasoning, { effort: 'medium', summary: 'auto', context: 'all_turns' });
    }
    const folders = (await readdir(join(state.out, 'requests'))).sort();
    assert.equal(folders.length, bodies.length);
    for (const [index, folder] of folders.entries()) {
      const dir = join(state.out, 'requests', folder);
      assert.deepEqual(await json(join(dir, 'request.json')), bodies[index]);
      assert.equal((await json(join(dir, 'metrics.json'))).status, 'completed');
      await json(join(dir, 'response.json'));
      await json(join(dir, 'output.json'));
      if (!isNative(bodies[index])) assert.ok((await readFile(join(dir, 'text.txt'), 'utf8')).length > 0);
      if (mode.startsWith('sse-')) assert.ok((await readFile(join(dir, 'events.jsonl'), 'utf8')).includes('response.completed'));
    }
    await assertPrivateTree(state.out);
    const count = state.requests.length;
    const reuse = await state.run(args);
    assert.notEqual(reuse.code, 0, 'an existing output must not be reused');
    assert.equal(state.requests.length, count);
    assert.deepEqual(await json(join(state.out, 'manifest.json')), manifest);
  });
}

test('K4-only runs still generate one K3, but quiz only the selected product', async t => {
  const state = await setup(t);
  const result = await state.run(['--execute', '--products', 'K4', '--controls', 'none']);
  assert.equal(result.code, 0, result.stderr);
  const results = await json(join(state.out, 'results.json'));
  assert.deepEqual(results.stages.map(stage => stage.id), ['K3', 'K4']);
  assert.deepEqual(results.quizzes.map(quiz => quiz.id), ['K4']);
  assert.equal(state.requests.length, 3);
});

test('quiz scoring uses final_answer text when commentary is also present', async t => {
  const state = await setup(t, { mode: 'quiz-phases' });
  const result = await state.run(['--execute', '--products', 'K1']);
  assert.equal(result.code, 0, result.stderr);
  const results = await json(join(state.out, 'results.json'));
  for (const quiz of results.quizzes) {
    assert.equal(quiz.score.parse_error, null);
    assert.equal(quiz.score.total.correct, 2);
  }
});

test('usage attribution reports native and text tokens without exposing item IDs', async t => {
  const state = await setup(t, { mode: 'attribution' });
  const result = await state.run(['--execute', '--products', 'K3,K4', '--controls', 'none']);
  assert.equal(result.code, 0, result.stderr);
  const results = await json(join(state.out, 'results.json'));
  assert.equal(results.stages[0].metrics.product_output_kind, 'native');
  assert.equal(results.stages[1].metrics.product_output_kind, 'text');
  for (const { metrics } of [...results.stages, ...results.quizzes]) {
    assert.equal(metrics.product_output_tokens, 8);
    assert.equal(metrics.product_output_tokens_source, 'usage.attribution.items');
    assert.equal(metrics.output_item_usage_by_type.reasoning.output_tokens, 4);
    assert.ok(!JSON.stringify(metrics).includes('cmp_offline'));
    assert.ok(!JSON.stringify(metrics).includes('msg_offline'));
    assert.ok(!JSON.stringify(metrics).includes('rs_offline'));
  }
});

test('external questionnaire combines with the fixture without transmitting gold or evidence', async t => {
  const { quiz: _quiz, questions: _questions, ...fixtureValue } = fixture;
  const questionnaire = { fixture_id: fixture.id, quiz: 'Return JSON for external-id from the supplied history only.',
    questions: [{ id: 'external-id', question: 'What was recorded?', expected: { state: 'recorded', count: 2 },
      evidence: 'EXTERNAL_GOLD_MUST_STAY_LOCAL' }] };
  const state = await setup(t, { fixtureValue, questionnaire });
  const result = await state.run(['--execute', '--products', 'K1', '--controls', 'none']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await json(join(state.out, 'results.json'))).quizzes[0].score.total,
    { correct: 1, total: 1, accuracy: 1 });
  assert.equal(state.requests.length, 2);
  assert.ok(!JSON.stringify(state.requests).includes('EXTERNAL_GOLD_MUST_STAY_LOCAL'));
  assert.ok(!JSON.stringify(state.requests[0]).includes(questionnaire.quiz));
  assert.deepEqual(await json(join(state.out, 'snapshots/questions.json')), questionnaire);
});

for (const option of ['previous_response_id', 'conversation', 'input', 'instructions', 'tools', 'prompt']) {
  test(`options cannot inject hidden recovery context through ${option}`, async t => {
    const state = await setup(t);
    const options = join(state.root, 'options.json');
    await writeFile(options, JSON.stringify({ [option]: 'synthetic-context' }));
    const result = await state.run(['--execute', '--options', options]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /options cannot set/);
    assert.equal(state.requests.length, 0);
  });
}

test('K4 requires an explicit retained U even when that U is empty', async t => {
  const { retained: _retained, ...fixtureValue } = fixture;
  const state = await setup(t, { fixtureValue });
  const result = await state.run(['--execute']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /K4 requires fixture.retained/);
  assert.equal(state.requests.length, 0);
});

for (const mode of ['http-failed', 'sse-failed', 'sse-incomplete', 'missing-usage', 'sse-no-terminal',
  'sse-unfinished', 'tool-call', 'refused', 'native-missing-ciphertext', 'native-multiple']) {
  test(`${mode}: failed calls never produce a successful product or quiz`, async t => {
    const state = await setup(t, { mode });
    const result = await state.run(['--execute', '--products', mode.startsWith('native-') ? 'K3' : 'K1']);
    assert.notEqual(result.code, 0);
    assert.equal((await json(join(state.out, 'manifest.json'))).status, 'failed');
    assert.equal(state.requests.length, 1, 'failure must not trigger a retry or quiz');
    const results = await json(join(state.out, 'results.json'));
    assert.equal(results.stages.length, 0);
    assert.equal(results.quizzes.length, 0);
    assert.equal(results.failed_requests.length, 1);
    assert.equal(results.failed_requests[0].metrics.status, 'failed');
    assert.equal((await readdir(join(state.out, 'products'))).length, 0);
    const folders = await readdir(join(state.out, 'requests'));
    assert.equal(folders.length, 1);
    const dir = join(state.out, 'requests', folders[0]);
    assert.equal((await json(join(dir, 'metrics.json'))).status, 'failed');
    assert.ok((await readFile(join(dir, 'error.txt'), 'utf8')).length > 0);
  });
}

test('a later quiz failure preserves completed products and their usage', async t => {
  const state = await setup(t, { mode: 'quiz-failed' });
  const result = await state.run(['--execute', '--products', 'K3,K4', '--controls', 'none']);
  assert.notEqual(result.code, 0);
  const results = await json(join(state.out, 'results.json'));
  assert.deepEqual(results.stages.map(stage => stage.id), ['K3', 'K4']);
  assert.equal(results.quizzes.length, 0);
  assert.equal(results.failed_requests.length, 1);
  assert.equal(state.requests.length, 3);
  assert.deepEqual((await json(join(state.out, 'products/K3.json'))).checkpoint, checkpoint);
  assert.equal((await json(join(state.out, 'products/K4.json'))).text, summary('K4'));
});

test('manual reuse after a tool-call failure reads the same four products with six closed-book calls', async t => {
  const state = await setup(t, { mode: 'quiz-tool-call-once' });
  const failed = await state.run(['--execute']);
  assert.notEqual(failed.code, 0);
  const original = await json(join(state.out, 'results.json'));
  assert.equal(original.stages.length, 4);
  assert.equal(original.quizzes.length, 0);
  assert.equal(original.failed_requests.length, 1);
  assert.equal(state.requests.length, 5, 'failure does not retry');
  assert.ok(state.requests.slice(0, 4).every(({ body }) => body.tool_choice === 'auto'));
  const out = join(state.root, 'reuse');
  const args = ['--reuse-products', state.out, '--out', out];
  const planned = await state.run(args, { BENCHMARK_URL: '', BENCHMARK_HEADERS: 'invalid JSON' });
  assert.equal(planned.code, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).request_count, 6);
  await assert.rejects(stat(out), { code: 'ENOENT' });
  const result = await state.run([...args, '--execute']);
  assert.equal(result.code, 0, result.stderr);
  const manifest = await json(join(out, 'manifest.json'));
  const reused = await json(join(out, 'results.json'));
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.reuse_products.run, state.out);
  assert.match(manifest.reuse_products.manifest_sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.request_options.tool_choice, 'auto');
  assert.equal(manifest.recovery_request_options.tool_choice, 'none');
  assert.equal(reused.quizzes.length, 6);
  assert.deepEqual(Object.fromEntries(Object.entries(reused.completed_usage_by_kind).map(([kind, value]) => [kind, value.calls])),
    { control: 2, recovery: 4 });
  for (const [index, stage] of reused.stages.entries()) {
    assert.equal(stage.reused, true);
    assert.deepEqual(stage.metrics, original.stages[index].metrics);
    assert.equal(stage.source.run, state.out);
    assert.equal(stage.source.artifact, stage.artifact);
    assert.match(stage.source.sha256, /^[0-9a-f]{64}$/);
    assert.equal(await readFile(join(out, stage.artifact), 'utf8'), await readFile(join(state.out, stage.artifact), 'utf8'));
  }
  const quizzes = state.requests.slice(5).map(({ body }) => body);
  assert.equal(quizzes.length, 6);
  assert.ok(quizzes.every(body => state.isQuiz(body) && body.tool_choice === 'none'));
  for (const [index, id] of ['K1', 'K2', 'K3', 'K4'].entries()) {
    const k = id === 'K3' ? checkpoint : message('user', prompts['summary-prefix'] + '\n\n' + summary(id));
    assert.deepEqual(quizzes[index + 2].input, [...prefix, k, message('user', fixture.quiz)]);
  }
  assert.ok(!JSON.stringify(quizzes).includes(generationReasoning.encrypted_content));
  assert.ok(!JSON.stringify(quizzes).includes('RETAINED_U_MARKER'));
  assert.deepEqual(await json(join(state.out, 'results.json')), original);
  await assertPrivateTree(out);
  const selected = await state.run(['--execute', '--reuse-products', state.out, '--out', join(state.root, 'one'),
    '--products', 'K1', '--controls', 'none']);
  assert.equal(selected.code, 0, selected.stderr);
  assert.equal(state.requests.length, 12, 'selected-product reuse makes only one additional quiz call');
  assert.deepEqual((await json(join(state.root, 'one/results.json'))).stages.map(stage => stage.id), ['K1']);
});

for (const mismatch of ['fixture', 'model', 'definitions', 'prompt', 'prefix', 'options', 'empty-product']) {
  test(`reuse rejects ${mismatch} mismatch before any API call`, async t => {
    const state = await setup(t);
    const initial = await state.run(['--execute', '--products', 'K1', '--controls', 'none']);
    assert.equal(initial.code, 0, initial.stderr);
    const args = ['--execute', '--reuse-products', state.out, '--out', join(state.root, 'reuse'), '--products', 'K1'];
    if (mismatch === 'fixture') await writeFile(join(state.root, 'fixture.json'), JSON.stringify({ ...fixture, id: 'other-fixture' }));
    if (mismatch === 'model') args.push('--model', 'other-model');
    if (mismatch === 'definitions') {
      const manifest = await json(join(state.out, 'manifest.json'));
      manifest.definitions.K2.prompt = 'different-prompt';
      await writeFile(join(state.out, 'manifest.json'), JSON.stringify(manifest));
    }
    if (mismatch === 'prefix') await writeFile(join(state.root, 'instructions.txt'), 'Different instructions.');
    if (mismatch === 'options') {
      await writeFile(join(state.root, 'options.json'), JSON.stringify({ reasoning: { effort: 'high' } }));
      args.push('--options', join(state.root, 'options.json'));
    }
    if (mismatch === 'prompt') {
      const manifest = await json(join(state.out, 'manifest.json'));
      manifest.hashes.prompts.builtin = 'different-prompt-hash';
      await writeFile(join(state.out, 'manifest.json'), JSON.stringify(manifest));
    }
    if (mismatch === 'empty-product') {
      await writeFile(join(state.out, 'products/K1.json'), JSON.stringify({ id: 'K1', kind: 'text', text: ' ' }));
    }
    const result = await state.run(args, { BENCHMARK_URL: '', BENCHMARK_HEADERS: 'invalid JSON' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Reuse source/);
    if (mismatch === 'definitions') assert.match(result.stderr, /does not match current definitions/);
    assert.equal(state.requests.length, 2);
    await assert.rejects(stat(join(state.root, 'reuse')), { code: 'ENOENT' });
  });
}

test('reuse rejects K4 paired with a different native checkpoint', async t => {
  const state = await setup(t);
  const initial = await state.run(['--execute', '--products', 'K4', '--controls', 'none']);
  assert.equal(initial.code, 0, initial.stderr);
  const product = await json(join(state.out, 'products/K3.json'));
  product.checkpoint.encrypted_content = 'different-synthetic-checkpoint';
  await writeFile(join(state.out, 'products/K3.json'), JSON.stringify(product));
  const result = await state.run(['--execute', '--products', 'K4', '--controls', 'none',
    '--reuse-products', state.out, '--out', join(state.root, 'reuse')]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /K4 does not depend on the same K3/);
  assert.equal(state.requests.length, 3);
});

test('scoring supports JSON objects, explicit unordered arrays, duplicates, null, and strict types', () => {
  const questions = [
    { id: 'object', expected: { a: 1, b: { ready: true } } },
    { id: 'set', expected: ['x', 'y', 'x'], unordered: true },
    { id: 'ordered', expected: ['x', 'y'] },
    { id: 'unknown', expected: null },
    { id: 'missing', expected: null },
    { id: 'number', expected: 42 },
  ];
  const result = score(JSON.stringify({ object: { b: { ready: true }, a: 1 }, set: ['x', 'x', 'y'],
    ordered: ['y', 'x'], unknown: null, number: '42', extra: true }), questions);
  assert.equal(result.total.correct, 3);
  assert.equal(result.total.total, 6);
  assert.equal(result.unknown.correct, 1);
  assert.equal(result.answers.find(answer => answer.id === 'missing').missing, true);
  assert.deepEqual(result.unexpected_ids, ['extra']);
  assert.equal(score('{"set":["x","y","y"]}', [questions[1]]).total.correct, 0);
  assert.equal(score('{"object":{"a":1,"b":{"ready":true},"extra":0}}', [questions[0]]).total.correct, 0);
  for (const invalid of ['not JSON', '[]', 'null', '```json\n{}\n```']) {
    const failed = score(invalid, questions);
    assert.ok(failed.parse_error);
    assert.equal(failed.total.correct, 0);
  }
});

test('software-task questionnaire uses exact structured scoring', async () => {
  const { questions } = await json(new URL('./fixtures/normal-questions.json', import.meta.url));
  const answers = Object.fromEntries(questions.map(question => [question.id, structuredClone(question.expected)]));
  for (const question of questions) if (question.unordered) answers[question.id].reverse();
  assert.equal(score(JSON.stringify(answers), questions).total.correct, questions.length);
  answers.Q022.reverse();
  answers.Q087.lower_bound = 'min_chunk_bytes';
  const result = score(JSON.stringify(answers), questions);
  assert.equal(result.total.correct, questions.length - 2);
  assert.deepEqual(result.answers.filter(answer => !answer.correct).map(answer => answer.id), ['Q022', 'Q087']);
});
