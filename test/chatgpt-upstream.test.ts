import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { upstreamHeaders } from "../src/auth.ts";
import { buildCatalog, configSnippet } from "../src/catalog.ts";
import { CHATGPT_BASE_URL } from "../src/chatgpt-auth.ts";
import { resolveModel, upstreamBaseUrl, validateConfig } from "../src/config.ts";
import { UpstreamHttpError } from "../src/errors.ts";
import { createBridgeServer } from "../src/server.ts";
import { upstreamFetch } from "../src/upstream.ts";

function token(label: string, expires = Date.now() / 1000 + 3600) {
  return `synthetic.${Buffer.from(JSON.stringify({ sub: label, exp: expires })).toString("base64url")}.signature`;
}
function login(accessToken = token("first"), accountId = "account-synthetic") {
  return {
    auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
    tokens: { access_token: accessToken, refresh_token: "synthetic-refresh-secret", account_id: accountId, id_token: token("id") },
  };
}
async function fixture(t: TestContext, value = login()) {
  const home = await mkdtemp(join(tmpdir(), "bridge-chatgpt-upstream-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "auth.json");
  await writeFile(path, JSON.stringify(value));
  const config = validateConfig({
    upstreams: { subscription: { auth: { type: "chatgpt", codex_home: home } } },
    models: { gpt: { upstream: "subscription", catalog: "gpt-6.1-sol", model: "gpt-synthetic" } },
  });
  return { config, path, route: resolveModel(config, "gpt"), original: value.tokens.access_token };
}
const noNetwork: typeof fetch = async () => { throw new Error("Unexpected network request"); };

test("subscription config supplies its endpoint without reading credentials for catalog discovery", () => {
  const config = validateConfig({
    upstreams: { subscription: { auth: { type: "chatgpt", codex_home: "/synthetic-not-a-login-home" } } },
    models: { gpt: { upstream: "subscription", catalog: "gpt-6.1-sol", model: "gpt-synthetic" } },
  });
  assert.equal(upstreamBaseUrl(config.upstreams.subscription), CHATGPT_BASE_URL);
  assert.equal(buildCatalog(config).models[0].slug, "gpt");
  assert.match(configSnippet(config), /model_catalog_url/);
  const origin = resolveModel(config, "gpt").origin;
  config.upstreams.subscription.base_url = `${CHATGPT_BASE_URL}/`;
  assert.deepEqual(resolveModel(config, "gpt").origin, origin);
  config.upstreams.subscription.base_url = "https://proxy.example/v1";
  assert.equal(upstreamBaseUrl(config.upstreams.subscription), "https://proxy.example/v1");
  assert.notEqual(resolveModel(config, "gpt").origin.id, origin.id);
  for (const conflict of [{ api_key_env: "KEY" }, { api_key_command: ["helper"] }, { auth_header: "x-key" }]) {
    assert.throws(() => validateConfig({ ...config, upstreams: {
      subscription: { auth: { type: "chatgpt" }, ...conflict },
    } }), /cannot be combined/);
  }
  for (const auth of ["chatgpt", { type: "unknown" }, { type: "chatgpt", codex_home: "" }, { type: "chatgpt", account_id: "ignored" }]) {
    assert.throws(() => validateConfig({ ...config, upstreams: { subscription: { auth } } }), /Invalid configuration/);
  }
});

test("subscription headers follow each login snapshot and replace client or static credentials", async t => {
  const f = await fixture(t);
  f.route.upstream.headers = { authorization: "static-secret", "ChatGPT-Account-ID": "static-account" };
  const client = new Headers({ authorization: "client-secret", "chatgpt-account-id": "client-account", "session-id": "synthetic-session" });
  const first = await upstreamHeaders(f.route.upstream, "responses", new AbortController().signal, client, noNetwork);
  assert.equal(first.get("authorization"), `Bearer ${f.original}`);
  assert.equal(first.get("chatgpt-account-id"), "account-synthetic");
  assert.equal(first.get("session-id"), "synthetic-session");
  const replacement = login(token("second"), "account-second");
  await writeFile(f.path, JSON.stringify(replacement));
  const second = await upstreamHeaders(f.route.upstream, "responses", new AbortController().signal, client, noNetwork);
  assert.equal(second.get("authorization"), `Bearer ${replacement.tokens.access_token}`);
  assert.equal(second.get("chatgpt-account-id"), "account-second");
});

test("a rejected subscription request refreshes once and replays the exact body before streaming", async t => {
  const f = await fixture(t);
  const renewed = token("renewed");
  const calls: { url: string; body: string; headers: Headers }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const headers = new Headers(init!.headers);
    calls.push({ url: String(url), body: init!.body as string, headers });
    if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: renewed, refresh_token: "rotated-secret" });
    assert.equal(headers.get("chatgpt-account-id"), "account-synthetic");
    assert.equal(headers.get("x-openai-internal-codex-responses-lite"), "true");
    return headers.get("authorization") === `Bearer ${f.original}`
      ? Response.json({ error: { code: "token_expired" } }, { status: 401 })
      : new Response("accepted");
  };
  const body = { model: "gpt-synthetic", input: [{ type: "compaction_trigger" }], reasoning: { effort: "medium" } };
  const response = await upstreamFetch(f.route, "/responses", body, new AbortController().signal, undefined,
    { "x-openai-internal-codex-responses-lite": "true" }, transport);
  assert.equal(await response.text(), "accepted");
  assert.deepEqual(calls.map(call => call.url), [`${CHATGPT_BASE_URL}/responses`, "https://auth.openai.com/oauth/token", `${CHATGPT_BASE_URL}/responses`]);
  assert.equal(calls[0].body, calls[2].body);
  assert.equal(calls[2].headers.get("authorization"), `Bearer ${renewed}`);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).tokens.refresh_token, "rotated-secret");
});

test("authentication recovery is bounded and preserves the final native HTTP error", async t => {
  const f = await fixture(t);
  let refreshes = 0;
  let requests = 0;
  const original = '{"error":{"code":"workspace_denied","detail":"retained"}}';
  const transport: typeof fetch = async url => {
    if (String(url).endsWith("/oauth/token")) { refreshes++; return Response.json({ access_token: token("renewed") }); }
    requests++;
    return new Response(original, { status: 401, headers: { "x-request-id": "synthetic-error" } });
  };
  await assert.rejects(upstreamFetch(f.route, "/responses", {}, new AbortController().signal, undefined, undefined, transport), error => {
    assert(error instanceof UpstreamHttpError);
    assert.equal(error.status, 401);
    assert.equal(error.body, original);
    assert.equal(error.headers.get("x-request-id"), "synthetic-error");
    return true;
  });
  assert.equal(requests, 2);
  assert.equal(refreshes, 1);
  requests = 0;
  await assert.rejects(upstreamFetch(f.route, "/responses", {}, new AbortController().signal, undefined, undefined,
    async () => { requests++; return new Response("overloaded", { status: 503 }); }), UpstreamHttpError);
  assert.equal(requests, 1);
  delete f.route.upstream.auth;
  f.route.upstream.base_url = CHATGPT_BASE_URL;
  requests = 0;
  await assert.rejects(upstreamFetch(f.route, "/responses", {}, new AbortController().signal, undefined, undefined, transport), UpstreamHttpError);
  assert.equal(requests, 1);
  assert.equal(refreshes, 1);
});

test("cancelling inference lets an in-flight token rotation persist but sends no model request", async t => {
  const f = await fixture(t, login(token("expired", 1)));
  const controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const release = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const request = upstreamFetch(f.route, "/responses", {}, controller.signal, undefined, undefined, async (url, init) => {
    calls++;
    assert.equal(String(url), "https://auth.openai.com/oauth/token");
    started();
    await release;
    assert.equal(init!.signal!.aborted, false);
    return Response.json({ access_token: token("renewed"), refresh_token: "surviving-rotation" });
  });
  await entered;
  controller.abort();
  finish();
  await assert.rejects(request, error => error instanceof Error && error.name === "AbortError");
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).tokens.refresh_token, "surviving-rotation");
});

test("HTTP recovery records model exchanges without capturing OAuth tokens", async t => {
  const f = await fixture(t);
  f.config.inspect = { capture: true };
  const renewed = token("renewed-secret");
  const server = createBridgeServer(f.config, { fetch: async (url, init) => {
    if (String(url).endsWith("/oauth/token")) return Response.json({ access_token: renewed, refresh_token: "synthetic-rotated-secret" });
    if (new Headers(init!.headers).get("authorization") === `Bearer ${f.original}`) return new Response("expired", { status: 401 });
    return Response.json({ id: "resp_synthetic", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 } });
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt", input: "Hello", stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response.completed/);
  const { ids } = await (await fetch(`${base}/inspect/api/exchanges?since=0`)).json() as any;
  const detail: any = await (await fetch(`${base}/inspect/api/exchanges/${ids[0]}`)).json();
  assert.equal(detail.route.base_url, CHATGPT_BASE_URL);
  assert.deepEqual(detail.upstream.map((call: any) => call.response.status), [401, 200]);
  const captured = JSON.stringify(detail);
  for (const secret of [f.original, renewed, "synthetic-refresh-secret", "synthetic-rotated-secret"]) assert(!captured.includes(secret));
  assert(!captured.includes("/oauth/token"));
});
