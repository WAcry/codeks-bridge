import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { decodeCompaction, encodeCompaction, type CompactionCarrier } from "../src/carrier.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { UpstreamHttpError } from "../src/errors.ts";
import { LazyCompactionStore } from "../src/lazy-compaction.ts";
import type { AdapterId, Backend, BackendContext, BridgeConfig } from "../src/types.ts";

const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 80 };
const succeed: Backend = async (_context, writer) => { writer.textDelta("Synthetic detailed handoff."); return { usage, endTurn: true }; };
const never: Backend = async () => { throw new Error("Unexpected backend"); };

async function setup(t: TestContext, sourceBackend: Backend = succeed) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-compaction-"));
  t.after(() => rm(directory, { recursive: true }));
  const config: BridgeConfig = validateConfig({
    compaction_cache_dir: directory,
    upstreams: { native: { base_url: "https://source.example/v1" }, alternate: { base_url: "https://target.example/v1" } },
    models: {
      source: { catalog: "gpt-6.1-sol", upstream: "native", model: "source-deployment", compaction: { mode: "lazy" } },
      target: { catalog: "deepseek-flash", upstream: "alternate", model: "target-deployment" },
    },
  });
  const source = resolveModel(config, "source");
  const carrier: CompactionCarrier = {
    native: { source: source.origin, format: source.profile.native_compaction_format!, data: { type: "compaction", encrypted_content: "synthetic-native-checkpoint" } },
    handoff: {
      prefix: [message("developer", "Source instructions")],
      parameters: { model: "source", reasoning: { effort: "high" }, prompt_cache_key: "synthetic-cache-key" },
      responsesLite: true,
    },
  };
  const checkpoint = { type: "compaction", id: "cmp_synthetic", encrypted_content: encodeCompaction(carrier) };
  const backends: Record<AdapterId, Backend> = { "gpt-responses": sourceBackend, "claude-messages": never, "deepseek-chat": never };
  const context: BackendContext = {
    request: { model: "target", input: [message("developer", "Target instructions"), message("user", "Earlier retained work"), checkpoint, message("user", "Later work")], stream: true },
    route: resolveModel(config, "target"), signal: new AbortController().signal, responsesLite: true,
    onAccepted: () => assert.fail("Export must not accept the downstream response"),
  };
  return { config, carrier, checkpoint, backends, context, directory, store: new LazyCompactionStore(config, backends) };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test("lazy exports persist privately with separate usage and do not mutate input", async t => {
  let calls = 0;
  const f = await setup(t, async (ctx, writer) => { calls++; return succeed(ctx, writer); });
  const original = structuredClone(f.context.request);
  const result = await f.store.materialize(f.context);
  assert.deepEqual(f.context.request, original);
  const checkpoint = (result.input as any[]).find(item => item.type === "compaction");
  assert.equal(decodeCompaction(checkpoint.encrypted_content)!.summary, "Synthetic detailed handoff.");
  const files = await readdir(f.directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const path = join(f.directory, files[0]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { summary: "Synthetic detailed handoff.", usage });
  const restarted = new LazyCompactionStore(f.config, f.backends);
  await restarted.materialize(f.context);
  assert.equal(calls, 1);
});

test("memo identity includes retained history but excludes destination prefix and later work", async t => {
  let calls = 0;
  const f = await setup(t, async (ctx, writer) => { calls++; return succeed(ctx, writer); });
  await f.store.materialize(f.context);
  const changed = structuredClone(f.context.request);
  (changed.input as any[])[0] = message("developer", "Different target instructions");
  (changed.input as any[])[3] = message("user", "New later work");
  await f.store.materialize({ ...f.context, request: changed });
  assert.equal(calls, 1);
  (changed.input as any[])[1] = message("user", "Different retained work");
  await f.store.materialize({ ...f.context, request: changed });
  assert.equal(calls, 2);
});

test("materialization preserves positions of target incremental tool declarations", async t => {
  const f = await setup(t);
  const request = structuredClone(f.context.request);
  const input = request.input as any[];
  const declaration = { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "new_tool", parameters: {} }] };
  input.push(declaration, message("user", "Continue with this tool"));
  const result = await f.store.materialize({ ...f.context, request });
  assert.deepEqual((result.input as any[]).slice(3), input.slice(3));
  assert.deepEqual((result.input as any[]).slice(0, 2), input.slice(0, 2));
});

test("source lookup prefers its original alias and survives alias renaming", async t => {
  const aliases: string[] = [];
  const f = await setup(t, async (ctx, writer) => { aliases.push(ctx.route.slug); return succeed(ctx, writer); });
  f.config.models.alternateName = { ...f.config.models.source };
  await f.store.materialize(f.context);
  assert.deepEqual(aliases, ["source"]);
  delete f.config.models.source;
  const request = structuredClone(f.context.request);
  (request.input as any[])[1] = message("user", "Distinct retained input");
  await f.store.materialize({ ...f.context, request });
  assert.deepEqual(aliases, ["source", "alternateName"]);
});

test("cached summaries remain available without resolving their original source again", async t => {
  const f = await setup(t);
  await f.store.materialize(f.context);
  delete f.config.models.source;
  await new LazyCompactionStore(f.config, f.backends).materialize(f.context);
  const request = structuredClone(f.context.request);
  (request.input as any[])[1] = message("user", "Uncached history");
  await assert.rejects(f.store.materialize({ ...f.context, request }), /original compaction source is not configured/);
});

test("source failures propagate unchanged and do not create cache entries or retries", async t => {
  let calls = 0;
  const failure = new UpstreamHttpError(403, '{"error":{"code":"synthetic-policy"}}', new Headers());
  const f = await setup(t, async () => { calls++; throw failure; });
  await assert.rejects(f.store.materialize(f.context), error => error === failure);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(f.directory), []);
});

test("same-key callers serialize and a canceled queued caller cannot unlock the active export", async t => {
  const entered = gate();
  const finish = gate();
  let calls = 0;
  const f = await setup(t, async (ctx, writer) => { calls++; entered.resolve(); await finish.promise; return succeed(ctx, writer); });
  const first = f.store.materialize(f.context);
  await entered.promise;
  const cancel = new AbortController();
  const second = f.store.materialize({ ...f.context, signal: cancel.signal });
  const cancellation = assert.rejects(second, /Queued caller canceled/);
  cancel.abort(new Error("Queued caller canceled"));
  await cancellation;
  let thirdFinished = false;
  const third = f.store.materialize(f.context).then(value => { thirdFinished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(thirdFinished, false);
  finish.resolve();
  await Promise.all([first, third]);
  assert.equal(calls, 1);
});

test("canceling the active export does not cancel a queued caller's independent attempt", async t => {
  const entered = gate();
  let calls = 0;
  const f = await setup(t, async (ctx, writer) => {
    calls++;
    if (calls === 1) {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }));
    }
    return succeed(ctx, writer);
  });
  const cancel = new AbortController();
  const first = f.store.materialize({ ...f.context, signal: cancel.signal });
  const cancellation = assert.rejects(first, /First caller canceled/);
  await entered.promise;
  const second = f.store.materialize(f.context);
  cancel.abort(new Error("First caller canceled"));
  await cancellation;
  await second;
  assert.equal(calls, 2);
  assert.equal((await readdir(f.directory)).length, 1);
});
