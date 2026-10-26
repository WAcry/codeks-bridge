import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { buildCatalog, configSnippet } from "../src/catalog.ts";
import { CHATGPT_BASE_URL } from "../src/chatgpt-auth.ts";
import { validateConfig } from "../src/config.ts";
import { createBridgeServer } from "../src/server.ts";
import type { BridgeConfig, BridgeServerOptions } from "../src/types.ts";

function token(label: string) {
  return `synthetic.${Buffer.from(JSON.stringify({ sub: label, exp: Date.now() / 1000 + 3600 })).toString("base64url")}.signature`;
}

function configuration(home: string): BridgeConfig {
  return {
    upstreams: {
      subscription: { auth: { type: "chatgpt", codex_home: home } },
      inference: { base_url: "https://inference.example/v1" },
    },
    models: {
      claude: { upstream: "inference", catalog: "claude-sonnet-5-5", model: "claude-deployment" },
      flash: { upstream: "inference", catalog: "deepseek-flash", model: "flash-deployment" },
    },
  };
}

async function login(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "bridge-search-"));
  t.after(() => rm(home, { recursive: true }));
  const path = join(home, "auth.json");
  const access = token("search-access-secret");
  await writeFile(path, JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
    tokens: { access_token: access, account_id: "synthetic-search-account", refresh_token: "synthetic-search-refresh-secret" },
  }));
  const config = configuration(home);
  config.web_search = { upstream: "subscription" };
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

const post = (base: string, body: unknown, path = "/v1/alpha/search", headers: Record<string, string> = {}) => fetch(base + path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

async function latest(base: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const state: any = await (await fetch(`${base}/inspect/api/state`)).json();
    if (state.active === 0) {
      const { ids }: any = await (await fetch(`${base}/inspect/api/exchanges?since=0`)).json();
      return (await fetch(`${base}/inspect/api/exchanges/${ids.at(-1)}`)).json();
    }
    await delay(5);
  }
  throw new Error("Search capture did not settle");
}

test("standalone search is opt-in and enabling it changes no model catalog entries", async t => {
  const config = validateConfig(configuration("/synthetic-missing-search-login"));
  let calls = 0;
  const base = await serve(t, config, { fetch: async () => { calls++; throw new Error("Unexpected upstream call"); } });
  for (const path of ["/alpha/search", "/v1/alpha/search"]) {
    const response = await post(base, { model: "claude", commands: { search_query: [{ q: "synthetic" }] } }, path);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /not configured/);
  }
  assert.equal(calls, 0);
  const catalog = buildCatalog(config);
  assert.match(configSnippet(config), /web_search = "disabled"/);
  assert.doesNotMatch(configSnippet(config), /supports_standalone_web_search/);
  const enabled = validateConfig({ ...config, web_search: { upstream: "subscription" } });
  assert.deepEqual(buildCatalog(enabled), catalog);
  for (const catalogPath of [undefined, "/synthetic/catalog.json"]) {
    const snippet = configSnippet(enabled, catalogPath);
    assert.match(snippet, /web_search = "live"/);
    assert.match(snippet, /\[model_providers\.bridge\][\s\S]*supports_standalone_web_search = true/);
  }
  for (const web_search of [null, false, [], {}, { upstream: 1 }, { upstream: "missing" }, { upstream: "inference" }, { upstream: "subscription", model: "ignored" }]) {
    assert.throws(() => validateConfig({ ...config, web_search }), /Invalid configuration/);
  }
});

test("standalone search preserves model names, commands and opaque fields outside inference adapters", async t => {
  const f = await login(t);
  f.config.inspect = { capture: true };
  f.config.upstreams.subscription.options = { model: "do-not-use", temperature: 999 };
  f.config.upstreams.subscription.headers = { authorization: "synthetic-static-secret", "chatgpt-account-id": "static-account" };
  f.config.models.claude.options = { model: "also-do-not-use", tool_choice: "none" };
  const seen: { body: any; headers: Headers }[] = [];
  const reply = '{\n "output":"SEARCH_TEXT", "encrypted_output":"synthetic-ciphertext", "results":[{"ref_id":"turn0search0","future_result":{"kept":true}}], "future_response":[1,2]\n}';
  const base = await serve(t, f.config, {
    transformRequest: () => { throw new Error("Responses transform must not run for search"); },
    onResponseEvent: () => { throw new Error("Search must not synthesize Responses events"); },
    fetch: async (url, init) => {
      assert.equal(String(url), `${CHATGPT_BASE_URL}/alpha/search`);
      assert.equal(init!.method, "POST");
      const headers = new Headers(init!.headers);
      assert.equal(headers.get("authorization"), `Bearer ${f.access}`);
      assert.equal(headers.get("chatgpt-account-id"), "synthetic-search-account");
      assert.equal(headers.get("session-id"), "synthetic-session");
      assert.equal(headers.get("x-future-header"), "retained");
      for (const name of ["x-api-key", "api-key", "cookie", "anthropic-version"]) assert.equal(headers.has(name), false);
      seen.push({ body: JSON.parse(String(init!.body)), headers });
      return new Response(reply, { headers: { "content-type": "application/json", "x-search-future": "retained", etag: '"synthetic-etag"' } });
    },
  });
  for (const [i, model] of ["claude-sonnet-5-5", "deepseek-flash", "synthetic-client-alias"].entries()) {
    const request = {
      id: "synthetic-search-session", model,
      input: [{ type: "reasoning", encrypted_content: "unrecognized-synthetic-state" }, { type: "compaction_trigger" }],
      commands: { search_query: [{ q: "synthetic query" }], open: [{ ref_id: "turn0search0" }], future_command: { kept: true } },
      settings: { external_web_access: true, future_setting: "kept" }, max_output_tokens: 1234,
      // These are opaque to the search relay, even though Responses rejects them.
      previous_response_id: "synthetic-previous", conversation: "synthetic-conversation", background: true,
      tools: { future: true }, stream: "future-value", future_body: [1, { kept: true }],
    };
    const response = await post(base, request, i % 2 ? "/alpha/search" : "/v1/alpha/search", {
      authorization: "Bearer synthetic-client-secret", "chatgpt-account-id": "client-account", "x-api-key": "synthetic-client-key",
      "api-key": "synthetic-client-key-2", cookie: "synthetic-cookie-secret", "session-id": "synthetic-session", "x-future-header": "retained",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), reply);
    assert.equal(response.headers.get("x-search-future"), "retained");
    assert.equal(response.headers.get("etag"), '"synthetic-etag"');
    assert.deepEqual(seen[i].body, request);
  }
  assert.equal(seen.length, 3);
  const detail = await latest(base);
  assert.equal(detail.kind, "search");
  assert.equal(detail.model, "synthetic-client-alias");
  assert.equal(detail.upstream_model, "synthetic-client-alias");
  assert.equal(detail.upstream_calls[0].label, "search");
  assert.equal(detail.route.upstream, "subscription");
  assert.equal(detail.route.base_url, CHATGPT_BASE_URL);
  assert.equal(detail.stream, false);
  assert.equal(detail.outcome, "completed");
  assert.equal(detail.usage, null);
  assert.deepEqual(detail.annotations, []);
  assert.deepEqual(JSON.parse(detail.client.request.body.text), seen[2].body);
  assert.deepEqual(JSON.parse(detail.upstream[0].body.text), seen[2].body);
  assert.equal(detail.upstream[0].response.body.text, reply);
  assert.equal(detail.client.response.body.text, reply);
  const captured = JSON.stringify(detail);
  for (const secret of [f.access, "synthetic-client-secret", "synthetic-client-key", "synthetic-cookie-secret", "synthetic-static-secret"]) {
    assert.equal(captured.includes(secret), false);
  }
});

test("search HTTP failures retain native status, body and headers without model retries", async t => {
  const f = await login(t);
  let status = 400;
  let calls = 0;
  const body = '{ "error": { "code": "synthetic_search_policy", "future": { "retained": true } } }';
  const base = await serve(t, f.config, { fetch: async () => {
    calls++;
    return new Response(body, { status, headers: { "content-type": "application/problem+json", "retry-after": "23", "x-search-request-id": "synthetic" } });
  } });
  for (status of [400, 429, 503]) {
    const before = calls;
    const response = await post(base, { model: "claude", id: "synthetic-search", commands: { open: [{ ref_id: "missing" }] } });
    assert.equal(response.status, status);
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get("content-type"), "application/problem+json");
    assert.equal(response.headers.get("retry-after"), "23");
    assert.equal(response.headers.get("x-search-request-id"), "synthetic");
    assert.equal(calls, before + 1);
  }
});

test("search authentication recovers once and Inspector excludes OAuth credentials", async t => {
  const f = await login(t);
  f.config.inspect = { capture: true };
  const renewed = token("renewed-search-secret");
  const calls: { url: string; body: string; headers: Headers }[] = [];
  const reply = '{"output":"RECOVERED_SEARCH","encrypted_output":"synthetic-ciphertext","results":[]}';
  const base = await serve(t, f.config, { fetch: async (url, init) => {
    const headers = new Headers(init!.headers);
    calls.push({ url: String(url), body: String(init!.body), headers });
    if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: renewed, refresh_token: "synthetic-rotated-search-secret" });
    return headers.get("authorization") === `Bearer ${f.access}`
      ? new Response("expired", { status: 401 })
      : new Response(reply, { headers: { "content-type": "application/json" } });
  } });
  const request = { id: "synthetic-search", model: "claude", commands: { click: [{ ref_id: "turn1view0", id: 3 }] } };
  const response = await post(base, request);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), reply);
  assert.deepEqual(calls.map(call => call.url), [`${CHATGPT_BASE_URL}/alpha/search`, "https://auth.openai.com/oauth/token", `${CHATGPT_BASE_URL}/alpha/search`]);
  assert.equal(calls[0].body, calls[2].body);
  assert.equal(calls[2].headers.get("authorization"), `Bearer ${renewed}`);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).tokens.refresh_token, "synthetic-rotated-search-secret");
  const detail = await latest(base);
  assert.equal(detail.kind, "search");
  assert.equal(detail.outcome, "completed");
  assert.equal(detail.route.upstream, "subscription");
  assert.equal(detail.route.base_url, CHATGPT_BASE_URL);
  assert.equal(detail.route.upstream_model, "claude");
  assert.deepEqual(detail.upstream.map((call: any) => [call.label, call.response.status]), [["search", 401], ["search", 200]]);
  assert.deepEqual(JSON.parse(detail.client.request.body.text), request);
  assert.equal(detail.upstream[1].body.text, calls[2].body);
  assert.equal(detail.upstream[1].response.body.text, reply);
  assert.equal(detail.client.response.body.text, reply);
  for (const secret of [f.access, renewed, "synthetic-search-refresh-secret", "synthetic-rotated-search-secret", "/oauth/token"]) {
    assert.equal(JSON.stringify(detail).includes(secret), false);
  }
});

test("a second search HTTP 401 is returned unchanged instead of refreshing again", async t => {
  const f = await login(t);
  let searches = 0;
  let refreshes = 0;
  const body = '{"error":{"code":"synthetic_search_denied","detail":"retained"}}';
  const base = await serve(t, f.config, { fetch: async url => {
    if (String(url).endsWith("/oauth/token")) { refreshes++; return Response.json({ access_token: token("still-denied") }); }
    searches++;
    return new Response(body, { status: 401, headers: { "x-search-request-id": "synthetic-denial" } });
  } });
  const response = await post(base, { model: "claude", commands: { search_query: [{ q: "synthetic" }] } });
  assert.equal(response.status, 401);
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get("x-search-request-id"), "synthetic-denial");
  assert.equal(searches, 2);
  assert.equal(refreshes, 1);
});
