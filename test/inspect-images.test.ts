import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { encodeCompaction } from "../src/carrier.ts";
import { createBridgeServer } from "../src/server.ts";
import type { BridgeConfig, BridgeServerOptions } from "../src/types.ts";

async function fixture(t: TestContext, fetch: NonNullable<BridgeServerOptions["fetch"]>) {
  const home = await mkdtemp(join(tmpdir(), "bridge-inspect-images-"));
  t.after(() => rm(home, { recursive: true }));
  const token = `synthetic.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString("base64url")}.signature`;
  await writeFile(join(home, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt", tokens: { access_token: token, account_id: "synthetic-image-account" },
  }));
  const config: BridgeConfig = {
    inspect: { capture: true }, image_generation: { upstream: "images" },
    upstreams: {
      images: { base_url: "https://images.example/backend-api/codex", auth: { type: "chatgpt", codex_home: home } },
      inference: { base_url: "https://inference.example/v1" },
    },
    models: { "gpt-image-2": { catalog: "claude-sonnet-5-5", upstream: "inference", model: "claude-deployment" } },
  };
  const server = createBridgeServer(config, { fetch });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, token };
}

async function latest(base: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const state: any = await (await fetch(`${base}/inspect/api/state`)).json();
    if (state.active === 0) {
      const { ids }: any = await (await fetch(`${base}/inspect/api/exchanges?since=0`)).json();
      return (await fetch(`${base}/inspect/api/exchanges/${ids.at(-1)}`)).json();
    }
    await delay(5);
  }
  throw new Error("Image capture did not settle");
}

test("Inspector retains image generation and edit exchanges outside model routing", async t => {
  const bytes = Buffer.alloc(128 * 1024, 65).toString("base64");
  const opaque = [{ type: "compaction", encrypted_content: encodeCompaction({ summary: "Synthetic opaque image metadata" }) }];
  const usage = { input_tokens: 40, output_tokens: 10, total_tokens: 50, output_tokens_details: { image_tokens: 10 } };
  const reply = JSON.stringify({ created: 123, data: [{ b64_json: bytes, generation_id: "synthetic-generation" }], usage, output: opaque });
  const seen: { url: string; text: string; headers: Headers }[] = [];
  const f = await fixture(t, async (url, init) => {
    seen.push({ url: String(url), text: String(init?.body), headers: new Headers(init?.headers) });
    return new Response(reply, { headers: { "content-type": "application/json", "x-codex-imagegen-request-id": "synthetic-image-request" } });
  });
  for (const operation of ["generations", "edits"]) {
    const request = JSON.stringify({
      model: "gpt-image-2", prompt: `Synthetic ${operation} prompt`, background: "opaque",
      ...(operation === "edits" ? { images: [{ image_url: `data:image/png;base64,${bytes}` }] } : {}),
      // Independent image requests preserve future metadata without replay annotations.
      input: opaque,
    });
    const path = `/v1/images/${operation}`;
    const response = await fetch(f.base + path, {
      method: "POST", headers: { "content-type": "application/json", "x-codex-image-turn-id": "synthetic-turn" }, body: request,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), reply);
    const d = await latest(f.base);
    const call = seen.at(-1)!;
    assert.equal(call.url, `https://images.example/backend-api/codex/images/${operation}`);
    assert.equal(d.kind, "image_generation");
    assert.equal(d.stream, false);
    assert.equal(d.preview, `Synthetic ${operation} prompt`);
    assert.equal(d.input_items, null);
    assert.equal(d.model, "gpt-image-2");
    assert.equal(d.upstream_model, "gpt-image-2");
    assert.equal(d.adapter, null);
    assert.equal(d.route.upstream, "images");
    assert.equal(d.route.base_url, "https://images.example/backend-api/codex");
    assert.equal(d.route.upstream_model, "gpt-image-2");
    assert.equal(d.outcome, "completed");
    assert.deepEqual(d.usage, usage);
    assert.deepEqual(d.annotations, []);
    assert.equal(d.client.request.path, path);
    assert.equal(d.client.request.body.text, request);
    assert.equal(d.client.request.headers["x-codex-image-turn-id"], "synthetic-turn");
    assert.equal(d.upstream[0].body.text, call.text);
    assert.equal(d.upstream[0].label, "image_generation");
    assert.equal(d.upstream[0].response.body.text, reply);
    assert.equal(d.client.response.body.text, reply);
    assert.equal(d.client.response.headers["x-codex-imagegen-request-id"], "synthetic-image-request");
    assert.equal(d.client.response.events, null);
    assert.match(d.upstream[0].headers.authorization, /^\[redacted:/);
    assert.equal(JSON.stringify(d).includes(f.token), false);
  }
});

test("Inspector reports native image errors with original body and diagnostics", async t => {
  const reply = '{"error":{"code":"image_generation_user_error","message":"Synthetic correction required","detail":{"kept":true}}}';
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return new Response(reply, { status: 422, headers: { "content-type": "application/problem+json", "x-codex-imagegen-request-id": "synthetic-failure" } });
  });
  const response = await fetch(`${f.base}/images/edits`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2", prompt: "Synthetic edit", images: [] }),
  });
  assert.equal(response.status, 422);
  assert.equal(await response.text(), reply);
  const d = await latest(f.base);
  assert.equal(calls, 1);
  assert.equal(d.kind, "image_generation");
  assert.equal(d.outcome, "error");
  assert.equal(d.error, "Synthetic correction required");
  assert.equal(d.usage, null);
  assert.equal(d.upstream[0].response.body.text, reply);
  assert.equal(d.client.response.body.text, reply);
  assert.equal(d.client.response.headers["x-codex-imagegen-request-id"], "synthetic-failure");
  assert.deepEqual(d.annotations, []);
});
