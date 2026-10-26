import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { buildCatalog, configSnippet } from "../src/catalog.ts";
import { CHATGPT_BASE_URL } from "../src/chatgpt-auth.ts";
import { validateConfig } from "../src/config.ts";
import { createBridgeServer } from "../src/server.ts";
import type { BridgeConfig, BridgeServerOptions } from "../src/types.ts";

const token = (label: string) => `synthetic.${Buffer.from(JSON.stringify({ sub: label, exp: Date.now() / 1000 + 3600 })).toString("base64url")}.signature`;
const request = { model: "gpt-image-2", prompt: "A synthetic circle", background: "opaque" };

function configuration(home: string): BridgeConfig {
  return {
    upstreams: {
      subscription: { auth: { type: "chatgpt", codex_home: home } },
      inference: { base_url: "https://inference.example/v1" },
    },
    models: { claude: { upstream: "inference", catalog: "claude-sonnet-5-5", model: "deployment" } },
  };
}

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "bridge-images-"));
  t.after(() => rm(home, { recursive: true }));
  const path = join(home, "auth.json");
  const access = token("image-access");
  await writeFile(path, JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
    tokens: { access_token: access, account_id: "synthetic-image-account", refresh_token: "synthetic-image-refresh" },
  }), { mode: 0o600 });
  const config = configuration(home);
  config.image_generation = { upstream: "subscription" };
  return { config, path, access };
}

async function serve(t: TestContext, config: BridgeConfig, options: BridgeServerOptions) {
  const server = createBridgeServer(config, options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

const post = (base: string, path: string, body: unknown = request, headers: Record<string, string> = {}, signal?: AbortSignal) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal,
});

test("subscription images are opt-in, independent of search, and change no model catalog", async t => {
  const config = configuration("/synthetic-missing-image-login");
  let calls = 0;
  const base = await serve(t, config, { fetch: async () => { calls++; throw new Error("Unexpected upstream call"); } });
  for (const prefix of ["", "/v1"]) for (const operation of ["generations", "edits"]) {
    const response = await post(base, `${prefix}/images/${operation}`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /not configured/);
  }
  assert.equal(calls, 0);
  const catalog = buildCatalog(config);
  const enabled = validateConfig({ ...config, image_generation: { upstream: "subscription" } });
  assert.deepEqual(buildCatalog(enabled), catalog);
  for (const catalogPath of [undefined, "/synthetic/catalog.json"]) {
    assert.match(configSnippet(config, catalogPath), /image_generation = false/);
    assert.match(configSnippet(config, catalogPath), /requires_openai_auth = false/);
    const snippet = configSnippet(enabled, catalogPath);
    assert.match(snippet, /\[features\]\nimage_generation = true/);
    assert.match(snippet, /\[model_providers\.bridge\][\s\S]*requires_openai_auth = true/);
    assert.match(snippet, /experimental_bearer_token = "codeks-bridge-local"/);
    assert.match(snippet, /web_search = "disabled"/);
  }
  enabled.web_search = { upstream: "subscription" };
  const both = configSnippet(enabled);
  assert.match(both, /supports_standalone_web_search = true/);
  assert.match(both, /image_generation = true/);
  enabled.token_env = "SYNTHETIC_BRIDGE_KEY";
  assert.match(configSnippet(enabled), /env_key = "SYNTHETIC_BRIDGE_KEY"/);
  for (const image_generation of [null, false, [], {}, { upstream: 1 }, { upstream: "missing" }, { upstream: "inference" }, { upstream: "subscription", model: "ignored" }]) {
    assert.throws(() => validateConfig({ ...config, image_generation }), /Invalid configuration/);
  }
});

test("image routes keep client authentication and request size checks ahead of subscription access", async t => {
  const f = await fixture(t);
  f.config.request_max_mib = 1;
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; throw new Error("Unexpected upstream call"); };
  const base = await serve(t, f.config, { fetch });
  const origin = await post(base, "/v1/images/generations", request, { origin: "https://example.com" });
  assert.equal(origin.status, 403);
  await origin.text();
  const oversized = await post(base, "/v1/images/edits", { ...request, images: [{ image_url: "x".repeat(1024 * 1024) }] });
  assert.equal(oversized.status, 413);
  await oversized.text();
  const name = "BRIDGE_TEST_IMAGES_TOKEN";
  const prior = process.env[name];
  process.env[name] = "synthetic-bridge-token";
  t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
  const protectedBase = await serve(t, { ...f.config, token_env: name }, { fetch });
  const unauthorized = await post(protectedBase, "/images/generations");
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
  assert.equal(calls, 0);
});

test("image HTTP 401 refreshes subscription auth once and repeats the same image body", async t => {
  const f = await fixture(t);
  const renewed = token("renewed-image-access");
  const calls: { url: string; body: string; headers: Headers }[] = [];
  let deny = false;
  const base = await serve(t, f.config, { fetch: async (url, init) => {
    const headers = new Headers(init!.headers);
    calls.push({ url: String(url), body: String(init!.body), headers });
    if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: renewed, refresh_token: "synthetic-rotated-image-refresh" });
    return deny || headers.get("authorization") === `Bearer ${f.access}`
      ? new Response('{"error":{"code":"synthetic_auth_error"}}', { status: 401 })
      : Response.json({ created: 1, data: [{ b64_json: "synthetic-image" }] });
  } });
  const edited = { ...request, images: [{ image_url: "data:image/png;base64,c3ludGhldGlj" }] };
  const response = await post(base, "/images/edits", edited, { authorization: "Bearer synthetic-client-token", "chatgpt-account-id": "client-account" });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(calls.map(c => c.url), [`${CHATGPT_BASE_URL}/images/edits`, "https://auth.openai.com/oauth/token", `${CHATGPT_BASE_URL}/images/edits`]);
  assert.equal(calls[0].body, calls[2].body);
  assert.deepEqual(JSON.parse(calls[2].body), edited);
  assert.equal(calls[2].headers.get("authorization"), `Bearer ${renewed}`);
  assert.equal(calls[2].headers.get("chatgpt-account-id"), "synthetic-image-account");
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).tokens.refresh_token, "synthetic-rotated-image-refresh");
  calls.length = 0;
  deny = true;
  const failure = await post(base, "/v1/images/generations");
  assert.equal(failure.status, 401);
  assert.deepEqual(await failure.json(), { error: { code: "synthetic_auth_error" } });
  assert.equal(calls.filter(c => c.url.endsWith("/oauth/token")).length, 1);
  assert.equal(calls.filter(c => c.url.endsWith("/images/generations")).length, 2);
});

test("image timeout and client disconnect cancel the selected upstream without retry", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  f.config.upstreams.subscription.headers_timeout_ms = 20;
  let calls = 0;
  const hanging: typeof fetch = async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  };
  const base = await serve(t, f.config, { fetch: hanging });
  const timeout = await post(base, "/v1/images/generations");
  assert.equal(timeout.status, 504);
  await timeout.text();
  assert.equal(calls, 1);
  f.config.upstreams.subscription.headers_timeout_ms = null;
  let started!: () => void;
  let cancelled!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { cancelled = resolve; });
  const cancelBase = await serve(t, f.config, { fetch: async (_url, init) => {
    started();
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { cancelled(); reject(init!.signal!.reason); }, { once: true });
    });
  } });
  const abort = new AbortController();
  const pending = post(cancelBase, "/v1/images/edits", request, {}, abort.signal);
  await ready;
  abort.abort();
  await assert.rejects(pending, /abort/i);
  await done;
});
