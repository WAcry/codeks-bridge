#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { request } from './run.mjs';
import { score } from './score.mjs';

// Re-read one frozen native checkpoint without generating a new compaction.
async function main() {
  const { values: args } = parseArgs({ options: {
    fixture: { type: 'string' }, checkpoint: { type: 'string' }, out: { type: 'string' },
    model: { type: 'string' }, reader: { type: 'string', default: 'current' },
    execute: { type: 'boolean', default: false },
  } });
  for (const key of ['fixture', 'checkpoint', 'out', 'model']) {
    if (!args[key]) throw new Error(`Missing --${key}`);
  }
  if (!['current', 'historical'].includes(args.reader)) throw new Error('Invalid --reader');
  const fixtureBytes = await readFile(resolve(args.fixture));
  const checkpointBytes = await readFile(resolve(args.checkpoint));
  const fixture = JSON.parse(fixtureBytes), checkpoint = JSON.parse(checkpointBytes);
  if (!Array.isArray(fixture.tools) || !Array.isArray(fixture.questions) || typeof fixture.quiz !== 'string') {
    throw new Error('Expected a benchmark fixture with tools, questions, and quiz');
  }
  if (checkpoint.type !== 'compaction' || typeof checkpoint.encrypted_content !== 'string' || !checkpoint.encrypted_content) {
    throw new Error('Expected a raw native compaction item');
  }
  const base = await readFile(new URL('./prompts/base-instructions.txt', import.meta.url), 'utf8');
  const message = (role, text) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
  const historical = args.reader === 'historical';
  const body = {
    model: args.model, stream: true, store: false,
    input: [...(!historical && fixture.tools.length
      ? [{ type: 'additional_tools', role: 'developer', tools: fixture.tools }] : []),
    message('developer', base), checkpoint, message('user', fixture.quiz)],
    include: ['reasoning.encrypted_content'], parallel_tool_calls: false,
    reasoning: { effort: 'medium', context: 'all_turns', ...(!historical ? { summary: 'auto' } : {}) },
    tool_choice: historical ? 'auto' : 'none',
    ...(historical ? { text: { verbosity: 'low' } } : { prompt_cache_key: randomUUID() }),
  };
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const plan = { model: args.model, reader: args.reader, request_count: 1, execute: args.execute,
    fixture_sha256: hash(fixtureBytes), checkpoint_sha256: hash(checkpointBytes), base_sha256: hash(base),
    context: 'fixed prefix + only the native checkpoint + quiz; no retained users or generation reasoning' };
  console.log(JSON.stringify(plan));
  if (!args.execute) return;
  const url = process.env.BENCHMARK_URL;
  if (!url) throw new Error('Missing BENCHMARK_URL');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.pathname.endsWith('/responses')) {
    throw new Error('Expected a complete HTTP(S) /responses URL');
  }
  const headers = new Headers(JSON.parse(process.env.BENCHMARK_HEADERS ?? '{}'));
  headers.set('content-type', 'application/json');
  headers.set('x-openai-internal-codex-responses-lite', 'true');
  const out = resolve(args.out);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await mkdir(out, { mode: 0o700 });
  await mkdir(join(out, 'requests'), { mode: 0o700 });
  const save = (name, data) => writeFile(join(out, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await save('manifest.json', plan);
  try {
    const result = await request(url, headers, out, 'read-native', body, 'recovery');
    const scored = score(result.text, fixture.questions);
    await save('results.json', { status: 'completed', metrics: result.metrics, score: scored });
    console.log(JSON.stringify({ known: scored.known, unknown: scored.unknown }));
  } catch (error) {
    await save('results.json', { status: 'failed', metrics: error.request_metrics ?? null });
    throw error;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
