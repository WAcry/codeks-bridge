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
let quizCount = 0, questionCount = 0, requestCount = 0;
for (const sample of record.cases) {
  // Auxiliary cases share the main case's questions for the same seed.
  const questionsRef = sample.questions ?? record.cases.find(candidate =>
    candidate.experiment === 'main' && candidate.seed === sample.seed)?.questions;
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
console.log(JSON.stringify({ verified_files: listed.size, cases: record.cases.length,
  requests: requestCount, raw_quizzes_rescored: quizCount, answers_checked: questionCount }, null, 2));
