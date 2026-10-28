import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerContent } from './compare-prompts.mjs';
import { score } from './score.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Recompute a text-prompt comparison from its frozen inputs and public answers. */
export async function verifyComparisonRecord({ record, json, pathFor }) {
  const plan = await json('plan.json');
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const inputs = new Map();
  for (const input of plan.inputs) {
    const path = resolve(repository, input.path);
    assert(!isAbsolute(input.path) && !relative(repository, path).startsWith('..'), `Invalid input: ${input.path}`);
    assert(!inputs.has(input.path), `Duplicate input: ${input.path}`);
    const bytes = await readFile(path);
    assert.equal(bytes.length, input.bytes, `Input bytes: ${input.path}`);
    assert.equal(hash(bytes), input.sha256, `Input hash: ${input.path}`);
    inputs.set(input.path, bytes);
  }
  assert.equal(record.model, plan.model);
  assert.deepEqual(record.request_options, plan.request_options);
  const cases = new Map(plan.cases.map(item => [item.id, item]));
  assert.equal(cases.size, plan.cases.length, 'Duplicate planned case');
  assert.equal(new Set(record.cases.map(item => item.id)).size, record.cases.length, 'Duplicate recorded case');
  assert.deepEqual(record.cases.map(item => item.id).sort(), [...cases.keys()].sort(), 'Planned case coverage');
  const questionsFor = id => {
    const item = cases.get(id);
    assert(item, `Unknown case: ${id}`);
    const bytes = inputs.get(item.questions ?? item.fixture);
    assert(bytes, `Missing question input: ${id}`);
    return JSON.parse(bytes).questions;
  };
  const requests = new Map();
  let quizCount = 0, questionCount = 0;
  for (const request of record.requests) {
    assert(!requests.has(request.request), `Duplicate request: ${request.request}`);
    requests.set(request.request, request);
    const questions = questionsFor(request.case);
    const metrics = request.metrics;
    assert(['completed', 'failed'].includes(metrics.status), `Request status: ${request.request}`);
    if (metrics.status !== 'completed') continue;
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
      assert(count(metrics[key]), `Usage ${key}: ${request.request}`);
    }
    assert.equal(metrics.total_tokens, metrics.input_tokens + metrics.output_tokens, `Usage total: ${request.request}`);
    if (metrics.reasoning_tokens !== null) {
      assert(count(metrics.reasoning_tokens) && metrics.reasoning_tokens <= metrics.output_tokens, `Reasoning usage: ${request.request}`);
      assert.equal(metrics.non_reasoning_output_tokens, metrics.output_tokens - metrics.reasoning_tokens, `Text usage: ${request.request}`);
    }
    if (metrics.cached_tokens !== null) {
      assert(count(metrics.cached_tokens) && metrics.cached_tokens <= metrics.input_tokens, `Cached usage: ${request.request}`);
    }
    const text = await readFile(pathFor(request.text_artifact), 'utf8');
    if (metrics.kind === 'summary') {
      assert(text.trim(), `Empty summary: ${request.request}`);
      if (metrics.reasoning_tokens !== null) {
        assert.equal(metrics.product_output_tokens, metrics.output_tokens - metrics.reasoning_tokens, `Summary tokens: ${request.request}`);
      }
    } else {
      const content = answerContent(text);
      assert.deepEqual(request.score_strict, plain(score(text, questions)), `Strict score: ${request.request}`);
      assert.deepEqual(request.score_content, plain(score(content, questions)), `Content score: ${request.request}`);
      assert.equal(request.outer_code_fence_removed, content !== text, `Fence handling: ${request.request}`);
      quizCount++;
      questionCount += questions.length;
    }
  }
  const failures = record.requests.filter(request => request.metrics.status === 'failed');
  assert.equal(record.completed_requests, requests.size - failures.length, 'Completed request count');
  assert.equal(record.failed_requests, failures.length, 'Failed request count');
  assert.equal(new Set(record.failures.map(item => item.request)).size, record.failures.length, 'Duplicate failure');
  assert.deepEqual(record.failures.map(item => item.request).sort(), failures.map(item => item.request).sort(), 'Failure coverage');
  for (const failure of record.failures) {
    const request = requests.get(failure.request);
    assert.equal(failure.case, request.case, `Failed case: ${failure.request}`);
    assert.equal(failure.stage, request.stage, `Failed stage: ${failure.request}`);
  }
  for (const retry of record.manual_retries ?? []) {
    const original = requests.get(retry.retry_of), actual = requests.get(retry.request);
    assert(original && actual, `Missing retry reference: ${retry.request}`);
    assert.equal(original.metrics.status, 'failed', `Retry replaces completed request: ${retry.request}`);
    assert.equal(actual.retry_of, original.request, `Retry source: ${retry.request}`);
    assert.equal(actual.request_sha256, original.request_sha256, `Retry body: ${retry.request}`);
    for (const key of ['case', 'stage', 'prompt']) {
      assert.equal(actual[key], original[key], `Retry ${key}: ${retry.request}`);
    }
  }
  const referenced = new Set();
  const verifyStage = (stage, id, name, prompt) => {
    const actual = requests.get(stage.request);
    assert(actual, `Missing request: ${stage.request}`);
    assert.equal(stage.case, id, `Stage case: ${stage.request}`);
    assert.equal(stage.stage, name, `Stage name: ${stage.request}`);
    assert.equal(stage.prompt, prompt, `Stage prompt: ${stage.request}`);
    for (const key of ['case', 'stage', 'prompt', 'request_sha256', 'metrics', 'text_artifact',
      'score_strict', 'score_content', 'outer_code_fence_removed']) {
      assert.deepEqual(stage[key], actual[key], `Request projection ${key}: ${stage.request}`);
    }
    referenced.add(stage.request);
  };
  const baselines = new Map();
  for (const baseline of record.baselines) {
    assert(!baselines.has(baseline.id), `Duplicate baseline: ${baseline.id}`);
    baselines.set(baseline.id, baseline);
    assert.equal(baseline.fixture, cases.get(baseline.id)?.fixture, `Baseline fixture: ${baseline.id}`);
    assert.deepEqual(Object.keys(baseline.stages).sort(), [...(plan.controls ?? ['full', 'empty'])].sort(), `Control coverage: ${baseline.id}`);
    for (const [control, stage] of Object.entries(baseline.stages)) {
      verifyStage(stage, baseline.id, `control-${control}`, undefined);
    }
  }
  let productCount = 0;
  for (const sample of record.cases) {
    const definition = cases.get(sample.id);
    const baseline = baselines.get(sample.baseline_case);
    assert(baseline, `Missing baseline: ${sample.id}`);
    assert.equal(sample.fixture, definition.fixture, `Case fixture: ${sample.id}`);
    assert.equal(baseline.fixture, sample.fixture, `Shared baseline fixture: ${sample.id}`);
    assert.deepEqual(questionsFor(sample.id), questionsFor(baseline.id), `Shared baseline questions: ${sample.id}`);
    const prompts = plan.prompts.map(item => item.id);
    if (plan.cases.findIndex(item => item.id === sample.id) % 2) prompts.reverse();
    assert.deepEqual(sample.prompt_order, prompts, `Prompt order: ${sample.id}`);
    assert.deepEqual(Object.keys(sample.routes).sort(), [...prompts].sort(), `Route coverage: ${sample.id}`);
    for (const id of prompts) {
      const route = sample.routes[id];
      verifyStage(route.generation, sample.id, `generate-${id}`, id);
      if (route.generation.metrics.status !== 'completed') {
        assert.equal(route.product, undefined, `Failed generation product: ${sample.id}/${id}`);
        assert.equal(route.quiz, undefined, `Failed generation quiz: ${sample.id}/${id}`);
        continue;
      }
      const product = route.product;
      assert(product, `Missing product: ${sample.id}/${id}`);
      const bytes = await readFile(pathFor(product.artifact));
      assert.equal(bytes.length, product.utf8_bytes, `Product bytes: ${sample.id}/${id}`);
      assert.equal(hash(bytes), product.sha256, `Product hash: ${sample.id}/${id}`);
      assert.equal([...bytes.toString('utf8')].length, product.characters, `Product characters: ${sample.id}/${id}`);
      assert.equal(bytes.toString('utf8'), await readFile(pathFor(route.generation.text_artifact), 'utf8'), `Generated product: ${sample.id}/${id}`);
      assert.equal(product.output_tokens, route.generation.metrics.product_output_tokens, `Product tokens: ${sample.id}/${id}`);
      assert.equal(product.output_tokens_source, route.generation.metrics.product_output_tokens_source, `Token source: ${sample.id}/${id}`);
      verifyStage(route.quiz, sample.id, `quiz-${id}`, id);
      const empty = baseline.stages.empty;
      const replay = route.quiz.metrics.status === 'completed' && empty?.metrics.status === 'completed'
        ? route.quiz.metrics.input_tokens - empty.metrics.input_tokens : null;
      assert.equal(route.replay_input_tokens, replay, `Replay usage: ${sample.id}/${id}`);
      productCount++;
    }
  }
  for (const request of record.requests) {
    assert(referenced.has(request.request) || request.metrics.status === 'failed', `Unreferenced completed request: ${request.request}`);
  }
  return { cases: record.cases.length, products: productCount, requests: requests.size,
    failed_requests: failures.length, raw_quizzes_rescored: quizCount, answers_checked: questionCount };
}
