import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { score } from './score.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sum = (items, value) => items.reduce((total, item) => total + value(item), 0);
const mean = (items, value) => items.length ? sum(items, value) / items.length : null;
const contentText = text => text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)?.[1] ?? text;
const aggregateScore = ({ answers, ...result }) => JSON.parse(JSON.stringify(result));
const usageMetrics = usage => ({
  input_tokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  uncached_input_tokens: usage.input_tokens,
  cached_tokens: usage.cache_read_input_tokens ?? 0,
  cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
  cache_write_5m_tokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? null,
  cache_write_1h_tokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
  output_tokens: usage.output_tokens,
  thinking_tokens: usage.output_tokens_details?.thinking_tokens ?? null,
});

/** Recompute this Messages experiment from its public texts and hashed source fixtures. */
export async function verifyMessagesRecord({ record, json, pathFor }) {
  const plan = await json('plan.json');
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const inputs = new Map();
  for (const input of plan.inputs) {
    const path = resolve(repository, input.file);
    assert(!isAbsolute(input.file) && !relative(repository, path).startsWith('..'), `Invalid input path: ${input.file}`);
    const bytes = await readFile(path);
    assert.equal(bytes.length, input.bytes, `Input bytes: ${input.file}`);
    assert.equal(hash(bytes), input.sha256, `Input SHA-256: ${input.file}`);
    assert(!inputs.has(basename(input.file)), `Duplicate input: ${input.file}`);
    inputs.set(basename(input.file), { value: JSON.parse(bytes), sha256: input.sha256 });
  }
  for (const [name, key] of [['base_instructions', 'base_sha256'], ['compaction', 'prompt_sha256'], ['summary_prefix', 'summary_prefix_sha256']]) {
    const prompt = plan.prompts[name];
    const path = resolve(pathFor('.'), prompt.file);
    assert(!isAbsolute(prompt.file) && !relative(repository, path).startsWith('..'), `Invalid prompt path: ${prompt.file}`);
    const bytes = await readFile(path);
    assert.equal(bytes.length, prompt.bytes, `Prompt bytes: ${name}`);
    assert.equal(hash(bytes), prompt.sha256, `Prompt SHA-256: ${name}`);
    assert.equal(prompt.sha256, plan[key], `Prompt plan: ${name}`);
  }
  assert.equal(record.model, plan.model);
  assert.equal(record.effort, plan.effort);
  assert.equal(record.source_commit, plan.source_commit);
  assert.deepEqual(record.products, ['K2']);

  const attempts = new Map();
  for (const attempt of record.attempts) {
    const key = `${attempt.case}/${attempt.stage}`;
    assert(!attempts.has(key), `Duplicate attempt: ${key}`);
    attempts.set(key, attempt);
    if (attempt.final_usage) {
      const usage = usageMetrics(attempt.final_usage);
      assert.equal(attempt.message_stop, true, `Final usage without message_stop: ${key}`);
      assert.equal(attempt.stream_error, null, `Final usage with stream error: ${key}`);
      assert.equal(usage.input_tokens, attempt.observed_start_input_tokens, `Start/final input: ${key}`);
      assert.equal(usage.cache_write_1h_tokens, 0, `Unexpected 1h cache: ${key}`);
      assert.equal(usage.cache_write_5m_tokens, usage.cache_write_tokens, `Cache write accounting: ${key}`);
    }
    const retry = attempt.stage.match(/^(.*)-retry-(\d+)$/);
    if (retry) {
      const original = record.attempts.find(item => item.case === attempt.case && item.stage === retry[1]);
      assert(original && original.stream_error && !original.message_stop, `Retry without failed original: ${key}`);
      assert.equal(attempt.request_sha256, original.request_sha256, `Retry changed request: ${key}`);
    }
  }
  const withUsage = record.attempts.filter(attempt => attempt.final_usage);
  assert.equal(record.api_attempts, attempts.size);
  assert.equal(record.requests_with_final_usage, withUsage.length);
  const totals = Object.fromEntries(Object.keys(usageMetrics(withUsage[0].final_usage)).map(key => [key,
    sum(withUsage, attempt => usageMetrics(attempt.final_usage)[key] ?? 0)]));
  assert.deepEqual(record.total_final_usage, totals, 'Total final usage');

  const delivered = new Map();
  const quizFiles = new Set();
  const questionsByCase = new Map();
  let answerCount = 0;
  assert.equal(basename(plan.source_record), plan.source_record, 'Source record must be a sibling directory');
  const previous = JSON.parse(await readFile(resolve(pathFor('.'), '..', plan.source_record, 'results.json'), 'utf8'));
  assert.equal(new Set(record.cases.map(sample => sample.id)).size, record.cases.length, 'Duplicate case');
  for (const sample of record.cases) {
    const fixture = inputs.get(sample.fixture);
    assert(fixture, `Missing fixture: ${sample.id}`);
    assert.equal(sample.fixture_sha256, fixture.sha256, `Fixture SHA-256: ${sample.id}`);
    const questions = sample.group === 'normal' ? inputs.get('normal-questions.json').value.questions : fixture.value.questions;
    questionsByCase.set(sample.id, questions);
    for (const [name, stage] of Object.entries(sample.stages)) {
      assert.equal(stage.stage, name);
      assert.equal(stage.case, name.startsWith('control-') ? sample.baseline_case : sample.id);
      const key = `${stage.case}/${stage.attempt_stage}`;
      const attempt = attempts.get(key);
      assert(attempt?.final_usage, `Missing final attempt: ${key}`);
      for (const [field, value] of Object.entries(usageMetrics(attempt.final_usage))) {
        assert.equal(stage[field], value, `Usage ${field}: ${key}`);
      }
      assert.equal(stage.stop_reason, attempt.stop_reason, `Stop reason: ${key}`);
      assert.equal(stage.runner_failure, attempt.runner_failure, `Failure: ${key}`);
      assert.equal(stage.completed, attempt.message_stop && attempt.stop_reason === 'end_turn' && !stage.block_types.includes('tool_use'), `Completion: ${key}`);
      if (delivered.has(key)) assert.deepEqual(stage, delivered.get(key), `Shared baseline: ${key}`);
      delivered.set(key, stage);
      const filename = name === 'generate-K2' ? (stage.completed ? 'K2' : 'generate-K2-partial') : name;
      const file = `cases/${stage.case}/${filename}.txt`;
      const bytes = await readFile(pathFor(file));
      assert.equal(bytes.length, stage.text_utf8_bytes, `Text bytes: ${file}`);
      assert.equal(hash(bytes), stage.text_sha256, `Text SHA-256: ${file}`);
      if (name !== 'generate-K2') {
        const text = bytes.toString('utf8');
        assert.deepEqual(aggregateScore(score(text, questions)), sample[name], `Strict score: ${sample.id}/${name}`);
        assert.deepEqual(aggregateScore(score(contentText(text), questions)), sample[`${name}-content`], `Content score: ${sample.id}/${name}`);
        assert.equal(stage.outer_code_fence_removed, contentText(text) !== text, `Fence marker: ${file}`);
        if (!quizFiles.has(file)) answerCount += questions.length;
        quizFiles.add(file);
      }
    }
    const generation = sample.stages['generate-K2'];
    assert.equal(sample.product_tokens, generation.completed && generation.thinking_tokens !== null
      ? generation.output_tokens - generation.thinking_tokens : null, `K tokens: ${sample.id}`);
    if (sample.stages['quiz-K2']) {
      assert(generation.completed, `Quiz without completed K: ${sample.id}`);
      assert.equal(sample.replay_input_tokens, sample.stages['quiz-K2'].input_tokens - sample.stages['control-empty'].input_tokens, `Replay tokens: ${sample.id}`);
    }
    const prior = previous.cases.find(item => item.id === sample.id);
    assert.deepEqual(sample.gpt_comparison, {
      score: prior.quizzes.find(quiz => quiz.request === 'quiz-K2').score.known,
      product_tokens: prior.stages.find(stage => stage.request === 'generate-K2').product_output_tokens,
    }, `GPT comparison: ${sample.id}`);
  }
  assert.deepEqual([...delivered.keys()].sort(), withUsage.map(attempt => `${attempt.case}/${attempt.stage}`).sort(), 'Final attempt coverage');
  assert.deepEqual(record.requests, [...delivered.values()], 'Request list');
  for (const [name, group] of Object.entries(record.groups)) {
    const all = record.cases.filter(sample => sample.group === name);
    const done = all.filter(sample => sample.stages['quiz-K2']?.completed);
    const total = sum(done, sample => sample['quiz-K2'].known.total);
    const correct = sum(done, sample => sample['quiz-K2'].known.correct);
    const contentCorrect = sum(done, sample => sample['quiz-K2-content'].known.correct);
    const input = sum(done, sample => sample.stages['generate-K2'].input_tokens);
    const cached = sum(done, sample => sample.stages['generate-K2'].cached_tokens);
    const gptCorrect = sum(done, sample => sample.gpt_comparison.score.correct);
    const allInput = sum(all, sample => sample.stages['generate-K2'].input_tokens);
    const allCached = sum(all, sample => sample.stages['generate-K2'].cached_tokens);
    assert.deepEqual(group, {
      attempted_cases: all.length, cases: done.length, correct, total, accuracy: total ? correct / total : null,
      content_correct: contentCorrect, content_accuracy: total ? contentCorrect / total : null,
      all_attempts_content_denominator: sum(all, sample => questionsByCase.get(sample.id).filter(question => question.expected !== null).length),
      mean_product_tokens: mean(done, sample => sample.product_tokens),
      mean_replay_input_tokens: mean(done, sample => sample.replay_input_tokens),
      generation_input_tokens: input, generation_cached_tokens: cached, generation_cache_hit_rate: input ? cached / input : null,
      gpt_correct: gptCorrect, gpt_accuracy: total ? gptCorrect / total : null,
      gpt_mean_product_tokens: mean(done, sample => sample.gpt_comparison.product_tokens),
      all_attempts_generation_input_tokens: allInput, all_attempts_generation_cached_tokens: allCached,
      all_attempts_generation_cache_hit_rate: allInput ? allCached / allInput : null,
    }, `Group metrics: ${name}`);
  }
  return { verified_inputs: inputs.size, cases: record.cases.length, requests: attempts.size,
    final_usage_requests: withUsage.length, raw_quizzes_rescored: quizFiles.size, answers_checked: answerCount };
}
