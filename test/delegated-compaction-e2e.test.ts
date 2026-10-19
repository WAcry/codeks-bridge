import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { decodeCompaction } from "../src/carrier.ts";
import { resolveModel } from "../src/config.ts";
import { HANDOFF_PROMPT, SUMMARIZATION_PROMPT } from "../src/prompts.ts";
import { createBridgeServer } from "../src/server.ts";
import { formatSse } from "../src/sse.ts";
import type { BridgeConfig } from "../src/types.ts";

type Call = { path: string; body: any; headers: IncomingMessage["headers"] };
type Handler = (call: Call, res: ServerResponse) => void;
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const answer = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const trigger = { type: "compaction_trigger" };
const nativeUsage = { input_tokens: 1200, output_tokens: 120, total_tokens: 1320, input_tokens_details: { cached_tokens: 800 } };
const handoffUsage = { input_tokens: 600, output_tokens: 90, total_tokens: 690, input_tokens_details: { cached_tokens: 400 } };
const mainUsage = { input_tokens: 40, output_tokens: 8, total_tokens: 48 };
const tools = { type: "additional_tools", tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] };
const isNative = (body: any) => body.input?.at(-1)?.type === "compaction_trigger";
const isHandoff = (body: any) => body.input?.at(-1)?.content?.[0]?.text === HANDOFF_PROMPT;

function sse(res: ServerResponse, events: unknown[], headers: Record<string, string> = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", ...headers });
  res.end(events.map(event => formatSse(event)).join(""));
}
function gpt(res: ServerResponse, output: unknown[], usage = mainUsage, headers: Record<string, string> = {}) {
  sse(res, [{ type: "response.completed", response: { id: "resp_synthetic", status: "completed", output, usage } }], headers);
}
function claude(res: ServerResponse) {
  sse(res, [
    { type: "message_start", message: { id: "msg_synthetic", role: "assistant", content: [], usage: { input_tokens: 40, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Synthetic Claude reasoning.", signature: "synthetic-claude-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "CLAUDE_WORK_COMPLETE" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ], { "x-codex-turn-state": "synthetic-main-state" });
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function fixture(t: TestContext, handler: Handler, configure?: (config: BridgeConfig) => void) {
  const seen: Call[] = [];
  const failures: unknown[] = [];
  const upstream = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const call = { path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString()), headers: req.headers };
      seen.push(call);
      handler(call, res);
    } catch (error) {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end("Synthetic upstream assertion failed");
    }
  });
  const origin = await listen(upstream);
  t.after(() => close(upstream));
  const cache = await mkdtemp(join(tmpdir(), "bridge-delegated-compaction-"));
  const config: BridgeConfig = {
    compaction_cache_dir: cache,
    inspect: { capture: true },
    upstreams: {
      gpt: { base_url: `${origin}/gpt`, headers: { "x-executor-route": "gpt" } },
      claude: { base_url: `${origin}/claude`, headers: { "x-executor-route": "claude" } },
    },
    models: {
      gpt: { catalog: "gpt-6.1-sol", upstream: "gpt", model: "synthetic-gpt-worker", replay: { native_compaction_from: ["compressor"] } },
      claude: { catalog: "claude-sonnet-5-5", upstream: "claude", model: "synthetic-claude", compaction: { mode: "native", model: "compressor" } },
      compressor: {
        catalog: "gpt-6.1-sol", upstream: "gpt", model: "synthetic-gpt-compressor",
        reasoning: { default_effort: "high" }, replay: { native_compaction_from: ["gpt"] },
        compaction: { mode: "summary", model: "unused" },
      },
      unused: { catalog: "gpt-6.1-sol", upstream: "gpt", model: "synthetic-unused" },
    },
  };
  configure?.(config);
  let bridge = createBridgeServer(config);
  let url = await listen(bridge);
  t.after(() => close(bridge));
  t.after(() => assert.deepEqual(failures, []));
  return {
    seen, cache, config,
    get url() { return url; },
    async restart() { await close(bridge); bridge = createBridgeServer(config); url = await listen(bridge); },
  };
}
async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function result(response: Response): Promise<any> {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function latest(url: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const state: any = await (await fetch(`${url}/inspect/api/state`)).json();
    if (state.active === 0) {
      const { ids }: any = await (await fetch(`${url}/inspect/api/exchanges?since=0`)).json();
      return (await fetch(`${url}/inspect/api/exchanges/${ids.at(-1)}`)).json();
    }
    await delay(5);
  }
  throw new Error("Inspector exchange did not finish");
}

test("model switches retain native checkpoints for delegated recompression and account for each call separately", async t => {
  let checkpoints = 0;
  const f = await fixture(t, ({ path, body }, res) => {
    if (path === "/claude/messages") { claude(res); return; }
    assert.equal(path, "/gpt/responses");
    if (isNative(body)) {
      gpt(res, [{ type: "compaction", encrypted_content: `synthetic-native-${++checkpoints}` }], nativeUsage);
    } else if (isHandoff(body)) {
      const checkpoint = body.input.find((item: any) => item.type === "compaction");
      gpt(res, [answer(`HANDOFF_FOR_${checkpoint.encrypted_content}`)], handoffUsage, { "x-codex-turn-state": "synthetic-handoff-state" });
    } else gpt(res, [{ type: "reasoning", summary: [], encrypted_content: "synthetic-gpt-reasoning" }, answer("GPT_WORK_COMPLETE")]);
  });
  const firstUser = user("RETAINED_USER_TASK");
  const first = await result(await post(f.url, { model: "gpt", input: [tools, firstUser, answer("OLD_WORK"), trigger], reasoning: { effort: "xhigh" } }));
  const k1 = first.output[0];
  assert.equal(f.seen[0].body.reasoning.effort, "xhigh", "Self compaction keeps the working request's effort");
  const gptWork = await result(await post(f.url, { model: "gpt", input: [tools, firstUser, k1, user("GPT_CONTINUATION")] }));
  assert.equal(f.seen.length, 2, "Compatible GPT continuation does not need handoff");
  const afterGpt = [tools, firstUser, k1, user("GPT_CONTINUATION"), ...gptWork.output, user("CLAUDE_NEW_TASK")];
  const claudeWork = await result(await post(f.url, { model: "claude", input: afterGpt }));
  assert.deepEqual(f.seen.slice(2).map(call => [call.path, call.body.model]), [
    ["/gpt/responses", "synthetic-gpt-worker"], ["/claude/messages", "synthetic-claude"],
  ]);
  const newTools = [
    { type: "function_call", name: "lookup", call_id: "call_synthetic_new_work", arguments: "{}" },
    { type: "function_call_output", call_id: "call_synthetic_new_work", output: "NEW_TOOL_RESULT" },
  ];
  const recompressionInput = [...afterGpt, ...claudeWork.output, ...newTools, user("PRESERVE_NEW_CLAUDE_WORK"), trigger];
  const compactedResponse = await post(f.url, {
    model: "claude", input: recompressionInput, instructions: "WORKING_TASK_INSTRUCTIONS", reasoning: { effort: "max", summary: "none", context: "all_turns" },
    stream: true, tool_choice: "auto", prompt_cache_key: "synthetic-cache-key", future_parameter: { preserved: true },
  }, { "session-id": "synthetic-session", "thread-id": "synthetic-thread", "x-codex-turn-state": "synthetic-client-state" });
  assert.equal(compactedResponse.status, 200);
  const events = (await compactedResponse.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.equal(events.filter(event => event.type === "response.output_item.done" && event.item.type === "compaction").length, 1);
  assert.equal(events.at(-1).type, "response.completed");
  const compacted = events.at(-1).response;
  assert.equal(f.seen.length, 5, "Recompression uses the executor's compatible native K without generating another handoff");
  const native = f.seen.at(-1)!;
  assert.equal(native.body.model, "synthetic-gpt-compressor", "Delegation stops after one hop even if the executor delegates elsewhere");
  assert.ok(isNative(native.body), "The worker chooses native mode even when the executor's own mode is summary");
  assert.equal(native.body.reasoning.effort, "high");
  assert.equal(native.body.reasoning.context, "all_turns");
  assert.equal(native.body.instructions, "WORKING_TASK_INSTRUCTIONS");
  assert.equal(native.body.tool_choice, "auto");
  assert.deepEqual(native.body.future_parameter, { preserved: true });
  assert.ok(native.body.input.some((item: any) => item.encrypted_content === "synthetic-native-1"));
  assert.deepEqual(native.body.input.filter((item: any) => item.type.startsWith("function_call")), newTools);
  assert.match(JSON.stringify(native.body.input), /PRESERVE_NEW_CLAUDE_WORK/);
  assert.doesNotMatch(JSON.stringify(native.body.input), /HANDOFF_FOR_|synthetic-gpt-reasoning|synthetic-claude-signature/);
  assert.equal(native.headers["session-id"], "synthetic-session");
  assert.equal(native.headers["thread-id"], "synthetic-thread");
  assert.equal(native.headers["x-codex-turn-state"], "synthetic-client-state");
  assert.equal(native.headers["x-executor-route"], "gpt");
  assert.equal(native.headers["x-openai-internal-codex-responses-lite"], "true");
  assert.equal(compacted.model, "claude");
  assert.equal(compacted.usage.total_tokens, nativeUsage.total_tokens);
  const k2 = compacted.output[0];
  const carrier = decodeCompaction(k2.encrypted_content)!;
  assert.equal(carrier.native!.source.id, resolveModel(f.config, "compressor").origin.id);
  assert.equal(carrier.handoff!.parameters.model, "compressor");
  assert.equal(carrier.handoff!.parameters.reasoning!.effort, "high");
  assert.equal(carrier.summary, undefined);
  const nativeDetail = await latest(f.url);
  assert.equal(nativeDetail.model, "claude");
  assert.equal(nativeDetail.route.alias, "compressor");
  assert.equal(nativeDetail.annotations.find((note: any) => note.target === "client.request" && note.kind === "compaction").decision, "native");
  assert.ok(nativeDetail.annotations.filter((note: any) => note.target === "client.request" && note.kind === "reasoning").every((note: any) => note.decision === "drop"));
  assert.deepEqual(nativeDetail.upstream.map((call: any) => call.label), ["native"]);

  const retained = user("ACTUAL_CLIENT_RETAINED_HISTORY");
  const continuation = { model: "claude", input: [tools, retained, k2, user("POST_CHECKPOINT_WORK")], reasoning: { effort: "max" } };
  const response = await post(f.url, continuation, { "x-codex-turn-state": "synthetic-next-state" });
  assert.equal(response.headers.get("x-codex-turn-state"), "synthetic-main-state", "Auxiliary response headers do not replace the main response headers");
  const continued = await result(response);
  assert.equal(continued.usage.total_tokens, mainUsage.total_tokens);
  const handoff = f.seen[5];
  assert.equal(handoff.body.model, "synthetic-gpt-compressor");
  assert.equal(handoff.body.reasoning.effort, "high", "Handoff retains the recorded executor effort");
  assert.equal(handoff.headers["x-codex-turn-state"], "synthetic-next-state");
  assert.deepEqual(handoff.body.input, [tools, retained, { type: "compaction", encrypted_content: "synthetic-native-2" }, user(HANDOFF_PROMPT)]);
  assert.match(JSON.stringify(f.seen[6].body.messages), /HANDOFF_FOR_synthetic-native-2/);
  assert.match(JSON.stringify(f.seen[6].body.messages), /POST_CHECKPOINT_WORK/);
  const detail = await latest(f.url);
  assert.equal(detail.usage.total_tokens, mainUsage.total_tokens);
  assert.deepEqual(detail.upstream.map((call: any) => call.label), ["handoff", "main"]);
  assert.match(detail.upstream[0].response.body.text, /"total_tokens":690/);
  const cached = await Promise.all((await readdir(f.cache)).map(async name => JSON.parse(await readFile(join(f.cache, name), "utf8"))));
  assert.equal(cached.length, 2);
  assert.equal(cached.find(entry => entry.summary.endsWith("synthetic-native-2")).usage.input_tokens, handoffUsage.input_tokens);
  const before = f.seen.length;
  const returned = await result(await post(f.url, { ...continuation, model: "gpt" }));
  assert.equal(returned.usage.total_tokens, mainUsage.total_tokens);
  assert.equal(f.seen.length, before + 1);
  assert.ok(f.seen.at(-1)!.body.input.some((item: any) => item.encrypted_content === "synthetic-native-2"));
  assert.equal(decodeCompaction(k2.encrypted_content)!.summary, undefined, "Materialization never rewrites the client's saved K");
});

test("delegating without a mode retains the worker's summary default and uses the executor's effort default", async t => {
  const f = await fixture(t, (_call, res) => gpt(res, [answer("PORTABLE_SUMMARY")], handoffUsage), config => {
    config.models.claude.compaction = { model: "compressor" };
    delete config.models.compressor.reasoning;
    config.models.compressor.compaction = { mode: "native", model: "unused" };
    config.models.compressor.model = config.models.gpt.model;
    config.models.gpt.compaction = { mode: "summary", model: "compressor" };
  });
  const compressed = await result(await post(f.url, { model: "claude", input: [user("Keep this task"), trigger], reasoning: { effort: "max" } }));
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].body.model, "synthetic-gpt-worker");
  assert.equal(f.seen[0].body.reasoning.effort, resolveModel(f.config, "compressor").profile.default_effort);
  assert.equal(f.seen[0].body.input.at(-1).content[0].text, SUMMARIZATION_PROMPT);
  assert.deepEqual(decodeCompaction(compressed.output[0].encrypted_content), { summary: "PORTABLE_SUMMARY" });
  assert.equal(compressed.usage.total_tokens, handoffUsage.total_tokens);
  assert.deepEqual((await latest(f.url)).upstream.map((call: any) => call.label), ["summary"]);
  assert.equal(resolveModel(f.config, "gpt").origin.id, resolveModel(f.config, "compressor").origin.id);
  await result(await post(f.url, { model: "gpt", input: [user("Same deployment, separate preset"), trigger], reasoning: { effort: "high" } }));
  assert.equal(f.seen.length, 2);
  assert.equal(f.seen[1].body.reasoning.effort, resolveModel(f.config, "compressor").profile.default_effort,
    "A delegated alias selects its effort preset even when it shares the worker's deployment");
});

for (const failure of ["http", "stream"] as const) {
  test(`delegated native ${failure} failure preserves diagnostics without fallback or retry`, async t => {
    const error = { code: "server_is_overloaded", message: "Synthetic compressor unavailable", future_detail: { preserved: true } };
    const f = await fixture(t, ({ body }, res) => {
      assert.equal(body.model, "synthetic-gpt-compressor");
      assert.ok(isNative(body));
      if (failure === "http") {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "37", "x-future-error": "synthetic-native-failure" });
        res.end(JSON.stringify({ error }));
      } else sse(res, [{ type: "response.failed", response: {
        id: "resp_synthetic_failed", status: "failed", error,
        output: [{ type: "compaction", encrypted_content: "synthetic-partial-native" }], usage: nativeUsage,
      } }], { "x-future-error": "synthetic-native-failure" });
    });
    const response = await post(f.url, { model: "claude", input: [user("Keep the old history"), trigger], stream: true });
    assert.equal(response.headers.get("x-future-error"), "synthetic-native-failure");
    if (failure === "http") {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "37");
      assert.deepEqual(await response.json(), { error });
    } else {
      assert.equal(response.status, 200);
      const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.equal(events.at(-1).type, "response.failed");
      assert.deepEqual(events.at(-1).response.error, error);
      assert.deepEqual(events.at(-1).response.output, []);
      assert.equal(events.at(-1).response.usage, undefined);
      assert.equal(events.some(event => event.item?.type === "compaction" || event.type === "response.completed"), false);
    }
    assert.equal(f.seen.length, 1);
    assert.deepEqual(await readdir(f.cache), []);
  });
}

test("handoff stays bound to its recorded executor and a successful handoff survives a failed main request", async t => {
  let handoffs = 0;
  let mains = 0;
  const handoffError = { error: { code: "future_capacity_error", message: "Synthetic handoff rejection", detail: "retained" } };
  const mainError = { type: "error", error: { type: "permission_error", message: "Synthetic main rejection" } };
  const f = await fixture(t, ({ path, body }, res) => {
    if (isNative(body)) { gpt(res, [{ type: "compaction", encrypted_content: "synthetic-retry-native" }], nativeUsage); return; }
    if (isHandoff(body)) {
      assert.equal(body.model, "synthetic-gpt-compressor");
      if (++handoffs === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "23" });
        res.end(JSON.stringify(handoffError));
      } else gpt(res, [answer("CACHED_HANDOFF")], handoffUsage);
      return;
    }
    assert.equal(path, "/claude/messages");
    assert.match(JSON.stringify(body.messages), /CACHED_HANDOFF/);
    if (++mains === 1) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify(mainError));
    } else claude(res);
  });
  const compacted = await result(await post(f.url, { model: "claude", input: [user("Original task"), trigger] }));
  f.config.models.claude.compaction = { mode: "native", model: "unused" };
  await f.restart();
  const request = { model: "claude", input: [user("Actual retained history"), ...compacted.output, user("Continue")], stream: true };
  const first = await post(f.url, request);
  assert.equal(first.status, 429);
  assert.equal(first.headers.get("retry-after"), "23");
  assert.deepEqual(await first.json(), handoffError);
  assert.equal(handoffs, 1);
  assert.equal(mains, 0);
  assert.deepEqual(await readdir(f.cache), []);
  const second = await post(f.url, request);
  assert.equal(second.status, 403);
  const mainFailure: any = await second.json();
  assert.equal(mainFailure.error.code, "invalid_prompt");
  assert.deepEqual(mainFailure.error.upstream, { status: 403, body: mainError });
  assert.equal(handoffs, 2);
  assert.equal(mains, 1);
  assert.equal((await readdir(f.cache)).length, 1);
  await f.restart();
  const succeeded = await result(await post(f.url, { ...request, stream: false }));
  assert.equal(succeeded.usage.total_tokens, mainUsage.total_tokens);
  assert.equal(handoffs, 2, "The main request retry reuses the successful handoff, including after restart");
  assert.equal(mains, 2);
  assert.equal(f.seen.filter(call => isNative(call.body)).length, 1);
  const detail = await latest(f.url);
  assert.deepEqual(detail.upstream.map((call: any) => call.label), ["main"]);
});
