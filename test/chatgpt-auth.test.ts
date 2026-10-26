import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BridgeError } from "../src/errors.ts";
import { getChatgptCredentials, refreshChatgptCredentials, type ChatgptAuthConfig } from "../src/chatgpt-auth.ts";

const jwt = (data: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(data)).toString("base64url")}.synthetic`;
const freshToken = () => jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
const expiringToken = () => jwt({ exp: Math.floor(Date.now() / 1000) + 60 });
const noFetch: typeof globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
function record(accessToken = freshToken()): Record<string, any> {
  return { auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
    future_record_field: { keep: true }, tokens: {
      access_token: accessToken, refresh_token: "synthetic-refresh-1", account_id: "selected-workspace",
      id_token: jwt({ "https://api.openai.com/auth": { chatgpt_user_id: "synthetic-user", chatgpt_account_id: "different-jwt-workspace" } }),
      login_owner_id: "synthetic-login", future_token_field: { keep: true },
    } };
}
async function fixture(t: TestContext, document = record()) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-chatgpt-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "auth.json");
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  const auth: ChatgptAuthConfig = { type: "chatgpt", codex_home: directory };
  return { directory, path, auth, read: async () => JSON.parse(await readFile(path, "utf8")) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("ChatGPT file auth reloads each request and pairs the token with the saved workspace", async t => {
  const first = record();
  const f = await fixture(t, first);
  assert.deepEqual(await getChatgptCredentials(f.auth, noFetch), {
    accessToken: first.tokens.access_token, accountId: "selected-workspace",
  });
  const second = record(jwt({ exp: Math.floor(Date.now() / 1000) + 7200 }));
  second.tokens.account_id = "new-workspace";
  second.tokens.login_owner_id = "new-login";
  await writeFile(f.path, JSON.stringify(second));
  assert.deepEqual(await getChatgptCredentials(f.auth, noFetch), {
    accessToken: second.tokens.access_token, accountId: "new-workspace",
  });
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.directory;
  t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; });
  assert.equal((await getChatgptCredentials({ type: "chatgpt" }, noFetch)).accountId, "new-workspace");
  assert.equal((await getChatgptCredentials({ type: "chatgpt", codex_home: relative(process.cwd(), f.directory) }, noFetch)).accountId, "new-workspace");
});

test("ChatGPT auth rejects missing, malformed, API-key and incomplete login records without exposing values", async t => {
  const f = await fixture(t);
  for (const document of [
    "synthetic-sensitive-invalid-json", JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic-sensitive-key", tokens: record().tokens }),
    JSON.stringify({ OPENAI_API_KEY: "synthetic-sensitive-key", tokens: record().tokens }),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-sensitive-token" } }),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-sensitive-token\nsecond", account_id: "a" } }),
  ]) {
    await writeFile(f.path, document);
    await assert.rejects(getChatgptCredentials(f.auth, noFetch), error => {
      assert(error instanceof BridgeError);
      assert.equal(error.status, 401);
      assert.match(error.message, /cli_auth_credentials_store="file"/);
      assert(!error.message.includes("synthetic-sensitive"));
      return true;
    });
  }
  await assert.rejects(getChatgptCredentials({ type: "chatgpt", codex_home: join(f.directory, "missing") }, noFetch), /Cannot read ChatGPT file credentials/);
});

test("ChatGPT proactive refresh uses OAuth provenance, rotates tokens and preserves unrelated fields", async t => {
  const original = record(expiringToken());
  original.tokens.oauth_provenance = { issuer: "https://issuer.example/v1/", client_id: "synthetic-client", future: true };
  const f = await fixture(t, original);
  const access = freshToken();
  const identity = jwt({ "https://api.openai.com/auth": { chatgpt_user_id: "synthetic-user" }, refreshed: true });
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://issuer.example/v1/oauth/token");
    assert.equal(init?.redirect, "error");
    assert(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      grant_type: "refresh_token", client_id: "synthetic-client", refresh_token: "synthetic-refresh-1", refresh_reason: "proactive_expiry",
    });
    const current = await f.read();
    current.updated_while_refreshing = true;
    await writeFile(f.path, JSON.stringify(current));
    return Response.json({ access_token: access, id_token: identity, refresh_token: "synthetic-refresh-2" });
  };
  assert.deepEqual(await getChatgptCredentials(f.auth, fetch), { accessToken: access, accountId: "selected-workspace" });
  const stored = await f.read();
  assert.deepEqual(stored.future_record_field, original.future_record_field);
  assert.deepEqual(stored.tokens.future_token_field, original.tokens.future_token_field);
  assert.deepEqual(stored.tokens.oauth_provenance, original.tokens.oauth_provenance);
  assert.equal(stored.updated_while_refreshing, true);
  assert.equal(stored.tokens.login_owner_id, "synthetic-login");
  assert.equal(stored.tokens.refresh_token, "synthetic-refresh-2");
  assert.equal(stored.tokens.id_token, identity);
  assert(Date.now() - Date.parse(stored.last_refresh) < 5000);
  if (process.platform !== "win32") assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.directory), ["auth.json"]);
  assert.equal((await getChatgptCredentials(f.auth, fetch)).accessToken, access);
  assert.equal(calls, 1);
});

test("ChatGPT scheduled refresh supports old opaque tokens and retains omitted rotation fields", async t => {
  const original = record("synthetic-opaque-access");
  original.last_refresh = new Date(Date.now() - 9 * 86_400_000).toISOString();
  const f = await fixture(t, original);
  const fetch: typeof globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://auth.openai.com/oauth/token");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(body.refresh_reason, "scheduled");
    return Response.json({ access_token: "synthetic-new-opaque-access" });
  };
  await getChatgptCredentials(f.auth, fetch);
  const stored = await f.read();
  assert.equal(stored.tokens.refresh_token, original.tokens.refresh_token);
  assert.equal(stored.tokens.id_token, original.tokens.id_token);
  assert.equal(stored.tokens.access_token, "synthetic-new-opaque-access");
  assert.deepEqual(stored.tokens.oauth_provenance, { issuer: "https://auth.openai.com", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
  assert.equal((await getChatgptCredentials(f.auth, noFetch)).accessToken, "synthetic-new-opaque-access");
});

test("ChatGPT concurrent expiry and rejected-request recovery perform one refresh", async t => {
  const original = record(expiringToken());
  const f = await fixture(t, original);
  const rejected = { accessToken: original.tokens.access_token, accountId: original.tokens.account_id };
  const entered = deferred<void>();
  const response = deferred<Response>();
  const access = freshToken();
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; entered.resolve(); return response.promise; };
  const pending = getChatgptCredentials(f.auth, fetch);
  await entered.promise;
  const others = Array.from({ length: 12 }, (_, i) => i % 2 ? getChatgptCredentials(f.auth, fetch) : refreshChatgptCredentials(f.auth, rejected, fetch));
  response.resolve(Response.json({ access_token: access, refresh_token: "synthetic-refresh-2" }));
  const results = await Promise.all([pending, ...others]);
  assert(results.every(result => result.accessToken === access && result.accountId === rejected.accountId));
  assert.equal(calls, 1);
});

test("ChatGPT refresh preserves shared-file symlinks and deduplicates their aliases", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, record(expiringToken()));
  const alias = join(f.directory, "alias");
  await mkdir(alias);
  await symlink(f.path, join(alias, "auth.json"));
  const access = freshToken();
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return Response.json({ access_token: access });
  };
  const results = await Promise.all([
    getChatgptCredentials(f.auth, fetch),
    getChatgptCredentials({ type: "chatgpt", codex_home: alias }, fetch),
  ]);
  assert(results.every(value => value.accessToken === access));
  assert.equal(calls, 1);
  assert((await lstat(join(alias, "auth.json"))).isSymbolicLink());
  assert.equal((await f.read()).tokens.access_token, access);
});

test("ChatGPT unauthorized recovery refreshes a still-unexpired token and reuses later external updates", async t => {
  const original = record();
  const f = await fixture(t, original);
  const rejected = { accessToken: original.tokens.access_token, accountId: original.tokens.account_id };
  const access = jwt({ exp: Math.floor(Date.now() / 1000) + 7200 });
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).refresh_reason, "unauthorized_recovery");
    return Response.json({ access_token: access });
  };
  assert.equal((await refreshChatgptCredentials(f.auth, rejected, fetch)).accessToken, access);
  assert.equal((await refreshChatgptCredentials(f.auth, rejected, noFetch)).accessToken, access);
});

test("ChatGPT refresh never overwrites a different login or combines accounts", async t => {
  for (const change of ["account", "login", "user"] as const) {
    const original = record(expiringToken());
    const f = await fixture(t, original);
    const replacement = record();
    if (change === "account") replacement.tokens.account_id = "new-workspace";
    if (change === "login") replacement.tokens.login_owner_id = "new-login";
    if (change === "user") replacement.tokens.id_token = jwt({ "https://api.openai.com/auth": { chatgpt_user_id: "new-user" } });
    const fetch: typeof globalThis.fetch = async () => {
      await writeFile(f.path, JSON.stringify(replacement));
      return Response.json({ access_token: freshToken(), refresh_token: "must-not-be-written" });
    };
    await assert.rejects(getChatgptCredentials(f.auth, fetch), /login changed/);
    assert.deepEqual(await f.read(), replacement);
  }
});

test("ChatGPT refresh respects credentials rotated externally while the request is in flight", async t => {
  const original = record(expiringToken());
  const f = await fixture(t, original);
  const replacement = record();
  replacement.tokens.refresh_token = "external-refresh-token";
  const fetch: typeof globalThis.fetch = async () => {
    await writeFile(f.path, JSON.stringify(replacement));
    return Response.json({ access_token: "do-not-overwrite", refresh_token: "do-not-overwrite" });
  };
  assert.deepEqual(await getChatgptCredentials(f.auth, fetch), {
    accessToken: replacement.tokens.access_token, accountId: replacement.tokens.account_id,
  });
  assert.deepEqual(await f.read(), replacement);
});

test("ChatGPT refresh failures disclose no credential body and leave the login unchanged", async t => {
  const original = record(expiringToken());
  const f = await fixture(t, original);
  for (const outcome of [400, 401, 403, 503, "transport", "json", "missing", "empty", "invalid-id-token"] as const) {
    const fetch: typeof globalThis.fetch = async () => {
      if (outcome === "transport") throw new Error("synthetic-sensitive-transport");
      if (outcome === "json") return new Response("synthetic-sensitive-invalid-json");
      if (outcome === "missing") return Response.json({ refresh_token: "synthetic-sensitive-refresh" });
      if (outcome === "empty") return Response.json({ access_token: "new-access", refresh_token: "" });
      if (outcome === "invalid-id-token") return Response.json({ access_token: freshToken(), id_token: "synthetic-sensitive-not-a-jwt" });
      return Response.json({ error: "synthetic-sensitive-oauth", refresh_token: "synthetic-sensitive-refresh" }, { status: outcome });
    };
    await assert.rejects(getChatgptCredentials(f.auth, fetch), error => {
      assert(error instanceof BridgeError);
      assert(!error.message.includes("synthetic-sensitive"));
      assert.equal(error.cause, undefined);
      if ([400, 401, 403].includes(outcome as number)) assert.equal(error.status, 401);
      return true;
    });
    assert.deepEqual(await f.read(), original);
  }
  const refreshless = record(expiringToken());
  delete refreshless.tokens.refresh_token;
  await writeFile(f.path, JSON.stringify(refreshless));
  await assert.rejects(getChatgptCredentials(f.auth, noFetch), /no refresh token/);
});

test("ChatGPT refresh reports a persistence failure instead of returning uncommitted rotated credentials", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async t => {
  const original = record(expiringToken());
  const f = await fixture(t, original);
  const fetch: typeof globalThis.fetch = async () => {
    await chmod(f.directory, 0o500);
    return Response.json({ access_token: freshToken(), refresh_token: "synthetic-refresh-2" });
  };
  try {
    await assert.rejects(getChatgptCredentials(f.auth, fetch), /Cannot save refreshed ChatGPT credentials/);
    assert.deepEqual(await f.read(), original);
  } finally { await chmod(f.directory, 0o700); }
});
