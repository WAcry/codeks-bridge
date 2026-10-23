import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createBridgeServer, type BridgeConfig, type BridgeServerOptions } from "../src/index.ts";

const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const message = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const call = { type: "function_call", id: "fc_synthetic", name: "read", call_id: "call_synthetic", arguments: "{}" };
const completed = (output: unknown[]) => ({ id: "resp_synthetic", status: "completed", output, usage });
const nativeResponse = (output: unknown[]) => Response.json(completed(output));
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
  headers: { "content-type": "text/event-stream" },
});
const eventList = (text: string) => text.split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.slice(6)));
const config = (): BridgeConfig => ({
  upstreams: { synthetic: { base_url: "https://upstream.example/v1" } },
  models: {
    gpt: { catalog: "gpt-6.1-sol", upstream: "synthetic", model: "gpt-example" },
    claude: { catalog: "claude-opus-5-5", upstream: "synthetic", model: "claude-example" },
    flash: { catalog: "deepseek-flash", upstream: "synthetic", model: "flash-example" },
  },
});

async function start(t: TestContext, options: BridgeServerOptions, configuration = config()) {
  const server = createBridgeServer(configuration, options);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return async (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", "x-example-route": "gpt" }, body: JSON.stringify(body),
  });
}

test("embedded requests transform before routing and report committed events for SSE and JSON", async t => {
  for (const stream of [true, false]) {
    const events: any[] = [];
    let transformed: any;
    const post = await start(t, {
      async transformRequest(request, { headers }) {
        transformed = { ...request, model: headers.get("x-example-route")!, input: "Transformed input", client_metadata: { marker: "synthetic" } };
        return transformed;
      },
      async fetch(_url, init) {
        const body = JSON.parse(init!.body as string);
        assert.equal(body.model, "gpt-example");
        assert.equal(body.input[0].content[0].text, "Transformed input");
        return nativeResponse([call]);
      },
      onResponseEvent(request, event) {
        assert.equal(request, transformed);
        assert.equal(request.client_metadata.marker, "synthetic");
        events.push(event);
      },
    });
    const response = await post({ model: "replace-before-routing", input: "Original input", stream });
    assert.equal(response.status, 200);
    if (stream) assert.deepEqual(events, eventList(await response.text()));
    else assert.deepEqual(events.at(-1).response, await response.json());
    assert.equal(events.filter(event => event.type === "response.output_item.done" && event.item.type === "function_call").length, 1);
    assert.equal(events.filter(event => event.type === "response.completed").length, 1);
  }
});

test("fetch and observers belong to their server instance without replacing global fetch", async t => {
  const originalFetch = globalThis.fetch;
  const clients = await Promise.all(["first", "second"].map(async label => {
    const seen: string[] = [];
    const post = await start(t, {
      transformRequest(request) { request.input = label; },
      async fetch(_url, init) {
        assert.equal(JSON.parse(init!.body as string).input[0].content[0].text, label);
        return nativeResponse([message(label)]);
      },
      onResponseEvent(_request, event) {
        if (event.type === "response.output_item.done") seen.push(event.item.content[0].text);
      },
    });
    return { post, seen, label };
  }));
  await Promise.all(clients.map(async ({ post, seen, label }) => {
    await (await post({ model: "gpt", input: "Original" })).json();
    assert.deepEqual(seen, [label]);
  }));
  assert.equal(globalThis.fetch, originalFetch);
});

test("the client observer excludes tool events discarded after an upstream failure", async t => {
  const events: any[] = [];
  const post = await start(t, {
    async fetch() {
      return sse([
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.failed", response: { id: "resp_failed", status: "failed", error: { code: "synthetic_failure", message: "Failed" } } },
      ]);
    },
    onResponseEvent(_request, event) { events.push(event); },
  });
  const response = await post({ model: "gpt", input: "Run", stream: true });
  assert.deepEqual(events, eventList(await response.text()));
  assert(!events.some(event => event.item?.type === "function_call"));
  assert.equal(events.at(-1).type, "response.failed");
});

test("an observer failure ends its request without re-entering the failed callback", async t => {
  let observations = 0;
  const post = await start(t, {
    async fetch() { return nativeResponse([message("Hello")]); },
    onResponseEvent() {
      observations++;
      throw new Error("Synthetic observer failure");
    },
  });
  const events = eventList(await (await post({ model: "gpt", input: "Hello", stream: true })).text());
  assert.equal(events.at(-1).type, "response.failed");
  assert.match(events.at(-1).response.error.message, /Synthetic observer failure/);
  assert.equal(observations, 1);
});

test("translated adapters use the injected fetch and expose only Responses events", async t => {
  for (const model of ["claude", "flash"]) {
    const events: any[] = [];
    const post = await start(t, {
      async fetch(url) {
        if (model === "claude") {
          assert.equal(url, "https://upstream.example/v1/messages");
          return sse([
            { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "Hello" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
            { type: "message_stop" },
          ]);
        }
        assert.equal(url, "https://upstream.example/v1/chat/completions");
        return sse([
          { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        ]);
      },
      onResponseEvent(_request, event) { events.push(event); },
    });
    const response = await post({ model, input: "Hello", stream: true });
    assert.deepEqual(events, eventList(await response.text()));
    assert(events.every(event => event.type.startsWith("response.")));
    assert.equal(events.at(-1).type, "response.completed", JSON.stringify(events.at(-1)));
  }
});

test("compaction and deferred handoffs use the host fetch without exposing auxiliary events", async t => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-embedding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configuration = config();
  configuration.compaction_cache_dir = directory;
  configuration.models.claude.compaction = { mode: "native", model: "gpt" };
  const seen: string[] = [];
  const events: any[] = [];
  let transforms = 0;
  const post = await start(t, {
    transformRequest() { transforms++; },
    async fetch(url, init) {
      const body = JSON.parse(init!.body as string);
      if (body.input?.at(-1)?.type === "compaction_trigger") {
        seen.push("native");
        return nativeResponse([{ type: "compaction", encrypted_content: "synthetic-checkpoint" }]);
      }
      if (String(url).endsWith("/responses")) {
        seen.push("handoff");
        assert(body.input.some((item: any) => item.encrypted_content === "synthetic-checkpoint"));
        return nativeResponse([message("Portable synthetic summary.")]);
      }
      seen.push("main");
      assert(JSON.stringify(body.messages).includes("Portable synthetic summary."));
      return sse([
        { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "Continue" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ]);
    },
    onResponseEvent(request, event) { events.push({ model: request.model, event }); },
  }, configuration);
  const compacted = await (await post({ model: "claude", input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Retain this work" }] },
    { type: "compaction_trigger" },
  ] })).json() as any;
  assert.equal(compacted.status, "completed");
  const continued = await (await post({ model: "claude", input: [...compacted.output,
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
  ] })).json() as any;
  assert.equal(continued.status, "completed");
  assert.deepEqual(seen, ["native", "handoff", "main"]);
  assert.equal(transforms, 2);
  assert(events.every(({ model }) => model === "claude"));
  assert.equal(events.filter(({ event }) => event.type === "response.completed").length, 2);
  assert(!JSON.stringify(events).includes("Portable synthetic summary."));
});
