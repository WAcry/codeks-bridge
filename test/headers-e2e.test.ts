import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { createBridgeServer } from "../src/server.ts";
import { encodeCompaction } from "../src/carrier.ts";
import { resolveModel } from "../src/config.ts";
import type { BridgeConfig } from "../src/types.ts";

async function listen(t: TestContext, server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse, body: any) => void, configure?: (config: BridgeConfig) => void) {
  const upstream = await listen(t, createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    handler(req, res, JSON.parse(Buffer.concat(chunks).toString()));
  }));
  const config: BridgeConfig = {
    upstreams: { remote: { base_url: upstream } },
    models: {
      gpt: { upstream: "remote", model: "synthetic-gpt", catalog: "gpt-6.1-sol" },
      claude: { upstream: "remote", model: "synthetic-claude", catalog: "claude-sonnet-5-5" },
      flash: { upstream: "remote", model: "synthetic-flash", catalog: "deepseek-flash" },
    },
  };
  configure?.(config);
  return { upstream, config, bridge: await listen(t, createBridgeServer(config)) };
}

const usage = { input_tokens: 20, output_tokens: 3, total_tokens: 23 };
function success(path: string): string {
  const events = path === "/responses" ? [{ type: "response.completed", response: {
    id: "resp_synthetic", status: "completed", output: [{ type: "message", id: "msg_synthetic", role: "assistant", content: [{ type: "output_text", text: "Hello" }] }], usage,
  } }] : path === "/messages" ? [
    { type: "message_start", message: { id: "msg_synthetic", role: "assistant", content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ] : [
    { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3 } },
  ];
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test("all adapters forward routing and future headers across streaming and JSON responses", async t => {
  const seen: IncomingMessage["headers"][] = [];
  const f = await fixture(t, (req, res) => {
    seen.push(req.headers);
    const compressed = gzipSync(success(req.url!));
    res.writeHead(200, {
      "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": String(compressed.length),
      connection: "close, x-synthetic-hop", "x-synthetic-hop": "upstream-only",
      "x-codex-turn-state": "synthetic-sticky-response", "x-future-response": "new-protocol-metadata",
      "cache-control": "private, max-age=0", "x-request-id": "req_synthetic",
      etag: '"synthetic-upstream-body"', "content-md5": "synthetic-checksum", digest: "sha-256=synthetic-checksum",
      "content-digest": "sha-256=:synthetic-checksum:", "repr-digest": "sha-256=:synthetic-checksum:",
      "x-models-etag": "upstream-catalog-does-not-apply", "set-cookie": ["synthetic-a=1", "synthetic-b=2"],
    });
    res.end(compressed);
  });
  for (const model of ["gpt", "claude", "flash"]) for (const stream of [false, true]) {
    const response = await fetch(`${f.bridge}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "session-id": "synthetic-session", "thread-id": "synthetic-thread",
        "x-codex-turn-state": "synthetic-sticky-request", "x-future-request": "new-routing-data",
      },
      body: JSON.stringify({ model, input: "Hello", stream }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-codex-turn-state"), "synthetic-sticky-response");
    assert.equal(response.headers.get("x-future-response"), "new-protocol-metadata");
    assert.equal(response.headers.get("x-request-id"), "req_synthetic");
    assert.equal(response.headers.get("cache-control"), "private, max-age=0");
    assert.deepEqual(response.headers.getSetCookie(), ["synthetic-a=1", "synthetic-b=2"]);
    assert.notEqual(response.headers.get("x-models-etag"), "upstream-catalog-does-not-apply");
    assert.equal(response.headers.get("x-synthetic-hop"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    for (const name of ["etag", "content-md5", "digest", "content-digest", "repr-digest"]) assert.equal(response.headers.get(name), null);
    assert.match(response.headers.get("content-type")!, stream ? /text\/event-stream/ : /application\/json/);
    assert.match(await response.text(), /Hello/);
    assert.equal(seen.at(-1)!["session-id"], "synthetic-session");
    assert.equal(seen.at(-1)!["thread-id"], "synthetic-thread");
    assert.equal(seen.at(-1)!["x-codex-turn-state"], "synthetic-sticky-request");
    assert.equal(seen.at(-1)!["x-future-request"], "new-routing-data");
  }
  assert.equal(seen.length, 6);
});

test("bridge credentials and request framing are replaced before route and protocol overrides", async t => {
  const variable = `SYNTHETIC_HEADER_TEST_TOKEN_${process.pid}`;
  process.env[variable] = "synthetic-bridge-secret";
  t.after(() => { delete process.env[variable]; });
  let received: IncomingMessage["headers"] | undefined;
  let receivedBody: any;
  const f = await fixture(t, (req, res, body) => {
    received = req.headers; receivedBody = body;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(success(req.url!));
  }, config => {
    config.token_env = variable;
    config.upstreams.remote = { ...config.upstreams.remote,
      auth_header: "x-route-auth", api_key_command: [process.execPath, "-e", "process.stdout.write('synthetic-upstream-secret')"],
      headers: { "x-route-auth": "superseded-config-secret", "x-route-metadata": "configured-value", "x-openai-internal-codex-responses-lite": "false" },
    };
  });
  // node:http allows a Connection-nominated header; fetch owns this framing.
  const body = JSON.stringify({ model: "gpt", input: [{ type: "additional_tools", tools: [] }, { role: "user", content: "Hello" }], stream: false });
  const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(`${f.bridge}/responses`, { method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(body), host: "synthetic-client.example",
      authorization: "Bearer synthetic-bridge-secret", "x-api-key": "synthetic-client-api-key", "api-key": "synthetic-client-api-key",
      cookie: "synthetic-client-cookie=1", "x-route-auth": "synthetic-client-custom-key",
      "x-route-metadata": "client-value", "x-openai-internal-codex-responses-lite": "false",
      "proxy-authorization": "synthetic-proxy-secret", connection: "close, x-client-hop", "x-client-hop": "local-only",
    } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end(body);
  });
  assert.equal(reply.status, 200);
  assert.match(reply.body, /Hello/);
  assert.ok(received);
  for (const name of ["authorization", "x-api-key", "api-key", "cookie", "proxy-authorization", "x-client-hop"]) assert.equal(received[name], undefined);
  assert.equal(received.host, new URL(f.upstream).host);
  assert.equal(received["x-route-auth"], "synthetic-upstream-secret");
  assert.equal(received["x-route-metadata"], "configured-value");
  assert.equal(received["x-openai-internal-codex-responses-lite"], "true");
  assert.equal(received["content-length"], String(Buffer.byteLength(JSON.stringify(receivedBody))));
  assert.notEqual(received["content-length"], String(Buffer.byteLength(body)));
});

test("HTTP failures preserve diagnostic headers and upstream bodies without retries", async t => {
  let calls = 0;
  const original = { error: { code: "future_policy_code", type: "invalid_request_error", message: "Synthetic diagnostic", detail: { state: "retained" } } };
  const text = JSON.stringify(original, null, 2);
  const f = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(403, {
      "content-type": "application/problem+json", "x-future-error": "synthetic-detail", "x-codex-turn-state": "synthetic-failure-state",
      "retry-after": "31", connection: "close, x-error-hop", "x-error-hop": "local-only",
      "set-cookie": ["synthetic-a=1", "synthetic-b=2"],
    });
    res.end(text);
  });
  for (const model of ["gpt", "claude", "flash"]) {
    const response = await fetch(`${f.bridge}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: "Hello", stream: true }) });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("x-future-error"), "synthetic-detail");
    assert.equal(response.headers.get("x-codex-turn-state"), "synthetic-failure-state");
    assert.equal(response.headers.get("retry-after"), "31");
    assert.equal(response.headers.get("x-error-hop"), null);
    assert.deepEqual(response.headers.getSetCookie(), ["synthetic-a=1", "synthetic-b=2"]);
    if (model === "gpt") {
      assert.equal(response.headers.get("content-type"), "application/problem+json");
      assert.equal(await response.text(), text);
    } else {
      assert.equal(response.headers.get("content-type"), "application/json");
      const result: any = await response.json();
      assert.equal(result.error.code, "invalid_prompt");
      assert.deepEqual(result.error.upstream, { status: 403, body: original });
    }
  }
  assert.equal(calls, 3);
});

test("handoff failures retain upstream headers and diagnostics", async t => {
  for (const transport of ["http", "stream"]) for (const stream of [false, true]) {
    await t.test(`${transport}, stream=${stream}`, async t => {
      let calls = 0;
      const original = { code: "invalid_encrypted_content", message: "Synthetic source failure", future_detail: { retained: true },
        headers: { "X-Codex-Turn-State": "synthetic-source-state", "x-future-error": "synthetic-payload-detail" } };
      const f = await fixture(t, (req, res) => {
        calls++;
        assert.equal(req.url, "/responses", "The destination must not be called after a failed handoff");
        res.writeHead(transport === "http" ? 403 : 200, {
          "content-type": transport === "http" ? "application/json" : "text/event-stream",
          "x-request-id": "req_synthetic_handoff", "x-future-response": "synthetic-source-metadata",
          "x-codex-turn-state": "synthetic-source-state",
        });
        res.end(transport === "http" ? JSON.stringify({ error: original }) : `data: ${JSON.stringify({
          type: "response.failed", response: { id: "resp_synthetic_handoff", status: "failed", error: original,
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Partial handoff" }] }], usage },
        })}\n\n`);
      }, config => {
        config.upstreams.alternate = { base_url: `${config.upstreams.remote.base_url}/alternate` };
        config.models.flash.upstream = "alternate";
      });
      const source = resolveModel(f.config, "gpt");
      const checkpoint = { type: "compaction", encrypted_content: encodeCompaction({
        native: { source: source.origin, format: source.profile.native_compaction_format!, data: { type: "compaction", encrypted_content: "synthetic-checkpoint" } },
        handoff: { prefix: [], parameters: { model: "gpt" }, responsesLite: true },
      }) };
      const response = await fetch(`${f.bridge}/responses`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "flash", input: [checkpoint], stream }) });
      assert.equal(response.headers.get("x-request-id"), "req_synthetic_handoff");
      assert.equal(response.headers.get("x-future-response"), "synthetic-source-metadata");
      assert.equal(response.headers.get("x-codex-turn-state"), "synthetic-source-state");
      if (transport === "http") {
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: original }, "Native HTTP bodies remain unchanged");
      } else {
        assert.equal(response.status, stream ? 200 : 502);
        const result: any = stream
          ? (await response.text()).split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.slice(6))).at(-1).response
          : await response.json();
        assert.deepEqual(result.error, original);
        assert.deepEqual(result.output, []);
        assert.equal(result.usage, undefined);
      }
      assert.equal(calls, 1);
    });
  }
});
