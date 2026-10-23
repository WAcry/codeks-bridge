#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { score } from './score.mjs';

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) {
  console.error('Usage: node benchmarks/compaction/verify-record.mjs <record-directory>');
  process.exit(1);
}
const root = resolve(directory);
const pathFor = name => {
  const path = resolve(root, name);
  assert(!isAbsolute(name) && !relative(root, path).startsWith('..'), `Invalid artifact path: ${name}`);
  return path;
};
const json = async name => JSON.parse(await readFile(pathFor(name), 'utf8'));
const artifacts = (await json('artifacts.json')).files;
const listed = new Set();
for (const artifact of artifacts) {
  assert(!listed.has(artifact.file), `Duplicate artifact: ${artifact.file}`);
  listed.add(artifact.file);
  const bytes = await readFile(pathFor(artifact.file));
  assert.equal(bytes.length, artifact.bytes, `Byte count: ${artifact.file}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256, `SHA-256: ${artifact.file}`);
}
async function files(path = root) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${entry.name}`);
    result.push(...(entry.isDirectory() ? await files(child) : [relative(root, child)]));
  }
  return result;
}
assert.deepEqual((await files()).filter(name => name !== 'artifacts.json').sort(), [...listed].sort(), 'Artifact coverage');

const record = await json('results.json');
if (record.protocol === 'anthropic-messages') {
  const { verifyMessagesRecord } = await import('./verify-messages-record.mjs');
  console.log(JSON.stringify({ verified_files: listed.size, ...await verifyMessagesRecord({ record, json, pathFor }) }, null, 2));
  process.exit(0);
}
let quizCount = 0, questionCount = 0, requestCount = 0;
for (const sample of record.cases) {
  const questionsRef = sample.questions;
  assert(questionsRef, `Missing question source: ${sample.id}`);
  const questions = (await json(questionsRef.file)).questions;
  for (const quiz of sample.quizzes) {
    const actual = score(await readFile(pathFor(quiz.answer_artifact.file), 'utf8'), questions);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), quiz.score, `Score: ${sample.id}/${quiz.request}`);
    quizCount++;
    questionCount += questions.length;
  }
  requestCount += sample.stages.length + sample.quizzes.length;
}
assert.equal(requestCount, record.completed_requests, 'Completed request count');
assert.equal(record.failed_requests, 0, 'This record must include only completed requests');
if (listed.has('report-summary.json')) {
  const report = await json('report-summary.json');
  const main = record.cases;
  const arms = ['K1', 'K2', 'K3', 'K4'];
  const { selection, groups } = report;
  assert.equal(selection.timing, 'post_hoc');
  assert.equal(selection.basis, 'user_selected_whole_case');
  assert.equal(selection.preregistered, false);
  assert.equal(selection.statistical_outlier_test, false);
  const excluded = selection.excluded_cases.map(sample => sample.id);
  assert(selection.excluded_cases.every(sample => typeof sample.reason === 'string' && sample.reason.length));
  const included = Object.values(groups).flatMap(group => group.case_ids);
  assert.equal(new Set([...included, ...excluded]).size, main.length, 'Selection must not duplicate cases');
  assert.deepEqual([...included, ...excluded].sort(), main.map(sample => sample.id).sort(), 'Selection must partition all main cases');
  assert.deepEqual([...included].sort(), [...selection.included_case_ids].sort(), 'Included case list');
  const sum = values => values.reduce((total, value) => total + value, 0);
  const mean = values => sum(values) / values.length;
  const stats = values => ({ mean: mean(values), min: Math.min(...values), max: Math.max(...values) });
  for (const [name, group] of Object.entries(groups)) {
    const samples = group.case_ids.map(id => main.find(sample => sample.id === id));
    assert(samples.length > 0, `Empty report group: ${name}`);
    assert.equal(group.n, samples.length, `Sample count: ${name}`);
    assert.deepEqual(Object.keys(group.arms), arms, `Report arms: ${name}`);
    const quizFor = (sample, arm) => sample.quizzes.find(quiz => quiz.request === `quiz-${arm}`);
    for (const sample of samples) {
      assert.deepEqual(sample.stages.map(stage => stage.request).sort(), arms.map(arm => `generate-${arm}`), `Whole-case generation: ${sample.id}`);
      assert.deepEqual(sample.quizzes.filter(quiz => /^quiz-K/.test(quiz.request)).map(quiz => quiz.request).sort(), arms.map(arm => `quiz-${arm}`), `Whole-case recovery: ${sample.id}`);
    }
    for (const arm of arms) {
      const quizzes = samples.map(sample => quizFor(sample, arm));
      const known = quizzes.map(quiz => quiz.score.known);
      const correct = sum(known.map(score => score.correct)), total = sum(known.map(score => score.total));
      assert.deepEqual(group.arms[arm], {
        n: samples.length,
        known: { correct, total, mean_accuracy: mean(known.map(score => score.accuracy)), pooled_accuracy: correct / total },
        known_perfect_cases: known.filter(score => score.correct === score.total).length,
        product_output_tokens: stats(samples.map(sample => sample.stages.find(stage => stage.request === `generate-${arm}`).product_output_tokens)),
        replay_input_tokens: stats(quizzes.map(quiz => quiz.replay_input_tokens)),
      }, `Derived report metrics: ${name}/${arm}`);
    }
    const pairs = samples.map(sample => {
      const native = quizFor(sample, 'K3').score, handoff = quizFor(sample, 'K4').score;
      const answers = score => score.answers.filter(answer => answer.category !== 'unknown');
      const before = answers(native), after = answers(handoff);
      assert.deepEqual(before.map(answer => answer.id), after.map(answer => answer.id), `Paired questions: ${sample.id}`);
      return { case: sample.id, known_correct_delta: handoff.known.correct - native.known.correct,
        known_accuracy_delta: handoff.known.accuracy - native.known.accuracy,
        gained: after.filter((answer, index) => answer.correct && !before[index].correct).length,
        lost: after.filter((answer, index) => !answer.correct && before[index].correct).length };
    });
    assert.deepEqual(group.native_to_handoff, { pairs,
      known_correct_delta: sum(pairs.map(pair => pair.known_correct_delta)),
      mean_known_accuracy_delta: mean(pairs.map(pair => pair.known_accuracy_delta)),
      gained: sum(pairs.map(pair => pair.gained)), lost: sum(pairs.map(pair => pair.lost)) }, `Paired report metrics: ${name}`);
  }
}
console.log(JSON.stringify({ verified_files: listed.size, cases: record.cases.length,
  requests: requestCount, raw_quizzes_rescored: quizCount, answers_checked: questionCount }, null, 2));
