import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createBridgeServer } from "../src/server.ts";
import { formatSse, parseJsonSse } from "../src/sse.ts";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("Claude refusal preserves original diagnostics through HTTP and SSE without releasing tools", async t => {
  let calls = 0;
  let terminal: Record<string, any>;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the request. */ }
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "Partial reply." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_synthetic", name: "lookup", input: { query: "synthetic" } } },
      { type: "content_block_stop", index: 1 },
      terminal,
      { type: "message_stop" },
    ]) res.write(formatSse(event));
    res.end();
  });
  const base = await listen(upstream);
  t.after(() => close(upstream));
  const bridge = createBridgeServer({
    upstreams: { test: { base_url: base } },
    models: { test: { catalog: "claude-sonnet-5-5", upstream: "test", model: "synthetic" } },
  });
  const url = await listen(bridge);
  t.after(() => close(bridge));

  const samples = [
    { details: { type: "refusal", category: "future_category", explanation: "Synthetic policy explanation.\nFull detail.", future: { id: "synthetic" } }, suffix: " future_category: Synthetic policy explanation.\nFull detail." },
    { details: { category: "cyber" }, suffix: " cyber" },
    { details: { explanation: "Synthetic explanation." }, suffix: " Synthetic explanation." },
    { details: { category: 7, explanation: null, future: [1, 2] }, suffix: "" },
    { details: null, suffix: "" },
    { details: undefined, suffix: "" },
  ];
  for (const sample of samples) for (const stream of [false, true]) {
    terminal = {
      type: "message_delta",
      delta: { stop_reason: "refusal", ...(sample.details !== undefined ? { stop_details: sample.details } : {}), future_delta: "preserved" },
      usage: { output_tokens: 5, future_usage: 3 }, future_event: "preserved",
    };
    const before = calls;
    const response = await fetch(`${url}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test", input: "Synthetic question.", stream,
        tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } } }],
      }),
    });
    let error: any;
    if (stream) {
      assert.equal(response.status, 200);
      const events = [];
      for await (const { json } of parseJsonSse(response.body!)) events.push(json);
      assert.equal(events.at(-1).type, "response.failed");
      assert.equal(events.some(event => ["function_call", "custom_tool_call"].includes(event.item?.type)), false);
      assert.equal(events.at(-1).response.output.some((item: any) => item.type === "function_call"), false);
      assert.equal(events.at(-1).response.usage, undefined);
      error = events.at(-1).response.error;
    } else {
      assert.equal(response.status, 400);
      const body = await response.json() as any;
      assert.equal(body.output, undefined);
      assert.equal(body.usage, undefined);
      error = body.error;
    }
    assert.equal(error.code, "invalid_prompt");
    assert.equal(error.message, `Messages refused the request.${sample.suffix}`);
    assert.deepEqual(error.upstream, { body: terminal });
    assert.equal(calls, before + 1);
  }
});
