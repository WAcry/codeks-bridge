import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { answerContent, execute, prepare } from './compare-prompts.mjs';

// Run explicitly. All model calls in this file use a local synthetic server.
const message = (role, text) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lastText = body => body.input.at(-1).content[0].text;

async function setup(t, failFirstSummary = false) {
  const root = await mkdtemp(join(tmpdir(), 'compare-prompts-offline-'));
  const fixture = {
    id: 'fixture', thread: [message('user', 'HISTORY secret-value'), message('assistant', 'Recorded')],
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
    quiz: 'QUIZ: return q and missing as a JSON object', questions: [
      { id: 'q', question: 'What value?', expected: 'secret-value', evidence: 'GOLD_MUST_STAY_LOCAL' },
      { id: 'missing', question: 'Unknown value?', expected: null },
    ], retained: [message('user', 'RETAINED_U_MUST_STAY_LOCAL')],
  };
  const files = {
    'fixture.json': JSON.stringify(fixture), 'instructions.txt': 'BASE INSTRUCTIONS',
    'prefix.txt': 'SUMMARY PREFIX', 'S.txt': 'PROMPT_S', 'A.txt': 'PROMPT_A',
  };
  await Promise.all(Object.entries(files).map(([file, value]) => writeFile(join(root, file), value)));
  const plan = {
    model: 'synthetic-model', request_options: { reasoning: { effort: 'high', summary: 'auto' }, tool_choice: 'auto' },
    base_instructions: 'instructions.txt', summary_prefix: 'prefix.txt',
    prompts: [{ id: 'S', path: 'S.txt' }, { id: 'A', path: 'A.txt' }],
    cases: [{ id: 'normal-r1', group: 'normal', fixture: 'fixture.json' },
      { id: 'normal-r2', group: 'normal', fixture: 'fixture.json' }],
    inputs: Object.entries(files).map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: sha256(value) })),
    controls: ['full', 'empty'], case_concurrency: 2,
  };
  const planPath = join(root, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const calls = [];
  let failed = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    const tail = lastText(body);
    if (failFirstSummary && !failed && tail === 'PROMPT_S') {
      failed = true;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'synthetic_overload', message: 'Try later' } }));
      return;
    }
    const summary = tail.startsWith('PROMPT_');
    const hasContext = body.input.some(item => item.content?.some(part => part.text?.includes('secret-value')));
    const text = summary ? `${tail}: secret-value` : JSON.stringify({ q: hasContext ? 'secret-value' : null, missing: null });
    const output = [
      { id: 'rs_synthetic', type: 'reasoning', status: 'completed', summary: [], encrypted_content: 'GENERATION_REASONING_MUST_STAY_LOCAL' },
      { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }] },
    ];
    const usage = { input_tokens: hasContext ? 100 : 20, output_tokens: 12, total_tokens: hasContext ? 112 : 32,
      input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 4 } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_synthetic', status: 'completed', output, usage }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { root, plan, planPath, calls, url: `http://127.0.0.1:${server.address().port}/responses` };
}

test('paired summaries share baselines, alternate prompts, and recover only from K', async t => {
  const fixture = await setup(t);
  const data = await prepare(fixture.planPath, undefined, fixture.root);
  const out = join(fixture.root, 'run');
  const result = await execute(data, out, { url: fixture.url, headers: {} });
  assert.equal(result.status, 'completed');
  assert.equal(result.requests.length, 10);
  assert.equal(result.baselines.length, 1);
  assert.deepEqual(result.cases.map(item => item.baseline_case), ['normal-r1', 'normal-r1']);
  assert.deepEqual(result.cases.map(item => item.prompt_order), [['S', 'A'], ['A', 'S']]);
  assert.equal(typeof result.baselines[0].fixture, 'string');
  assert.equal(lastText(fixture.calls[0]), 'QUIZ: return q and missing as a JSON object');
  assert.equal(fixture.calls[0].tool_choice, 'auto');
  for (const body of fixture.calls) {
    const encoded = JSON.stringify(body);
    assert(!encoded.includes('GOLD_MUST_STAY_LOCAL'));
    assert(!encoded.includes('RETAINED_U_MUST_STAY_LOCAL'));
    assert(!encoded.includes('GENERATION_REASONING_MUST_STAY_LOCAL'));
    if (lastText(body).startsWith('PROMPT_')) {
      assert.equal(body.tool_choice, 'auto');
      assert(encoded.includes('HISTORY secret-value'));
      assert(!encoded.includes('QUIZ:'));
    } else if (encoded.includes('SUMMARY PREFIX')) {
      assert.equal(body.tool_choice, 'none');
      assert(!encoded.includes('HISTORY secret-value'));
    }
  }
  for (const sample of result.cases) for (const route of Object.values(sample.routes)) {
    assert.equal(route.product.output_tokens, 8);
    assert.equal(route.replay_input_tokens, 80);
    assert.equal(route.quiz.score_content.known.correct, 1);
    assert.equal(route.quiz.score_strict.known.correct, 1);
  }
  assert.deepEqual(JSON.parse(await readFile(join(out, 'results.json'), 'utf8')), JSON.parse(JSON.stringify(result)));
  await assert.rejects(execute(data, out, { url: fixture.url, headers: {} }), /EEXIST/);
});

test('failed generation is retained without retry; other routes and cases continue', async t => {
  const fixture = await setup(t, true);
  const data = await prepare(fixture.planPath, undefined, fixture.root);
  const result = await execute(data, join(fixture.root, 'run'), { url: fixture.url, headers: {} });
  assert.equal(result.status, 'completed_with_failures');
  assert.equal(result.failures.length, 1);
  assert.equal(result.requests.length, 9);
  assert.equal(result.cases[0].routes.S.generation.metrics.status, 'failed');
  assert.equal(result.cases[0].routes.S.quiz, undefined);
  assert.equal(result.cases[0].routes.A.quiz.metrics.status, 'completed');
  assert.equal(result.cases[1].routes.S.quiz.metrics.status, 'completed');
  assert.equal(fixture.calls.filter(body => lastText(body) === 'PROMPT_S').length, 2);
});

test('plan validation rejects changed inputs and keeps original case index when filtered', async t => {
  const fixture = await setup(t);
  const selected = await prepare(fixture.planPath, ['normal-r2'], fixture.root);
  assert.deepEqual(selected.cases[0].promptOrder, ['A', 'S']);
  assert.equal(fixture.calls.length, 0);
  await writeFile(join(fixture.root, 'S.txt'), 'CHANGED');
  await assert.rejects(prepare(fixture.planPath, undefined, fixture.root), /Input hash mismatch/);
  assert.equal(fixture.calls.length, 0);
});

test('content scoring only strips a complete outer JSON fence', () => {
  assert.equal(answerContent('```json\n{"q":1}\n```'), '{"q":1}');
  assert.equal(answerContent('prefix\n```json\n{"q":1}\n```'), 'prefix\n```json\n{"q":1}\n```');
  assert.equal(answerContent('```json\n{"q":1}'), '```json\n{"q":1}');
});
