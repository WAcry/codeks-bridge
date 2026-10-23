import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { resolveModel, validateConfig } from "../src/config.ts";
import { BridgeError, responsesStreamError, transportError, upstreamError, UpstreamHttpError } from "../src/errors.ts";
import { upstreamFetch } from "../src/upstream.ts";

const route = () => resolveModel({
  upstreams: { remote: { base_url: "https://upstream.example/v1" } },
  models: { chosen: { upstream: "remote", model: "synthetic-model", catalog: "gpt-6.1-sol" } },
}, "chosen");

test("HTTP errors retain the original JSON or text and never retry", async (t) => {
  const cases = [
    {
      status: 429,
      body: { error: { code: "capacity_pool_empty", type: "capacity_error", message: "No workers available", param: "model", details: { pool: "synthetic" } }, request_id: "req_synthetic" },
    },
    { status: 503, body: "Maintenance in progress\nPlease try again later." },
    { status: 400, body: { error: "Unsupported request field" } },
  ];
  for (const failure of cases) {
    let calls = 0;
    const mocked = t.mock.method(globalThis, "fetch", async (url: unknown) => {
      calls++;
      assert.equal(url, "https://upstream.example/v1/responses");
      return new Response(typeof failure.body === "string" ? failure.body : JSON.stringify(failure.body), {
        status: failure.status, headers: { "retry-after": "23" },
      });
    });
    await assert.rejects(upstreamFetch(route(), "/responses", { model: "synthetic-model" }, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof UpstreamHttpError);
      assert.equal(error.status, failure.status);
      assert.equal(error.body, typeof failure.body === "string" ? failure.body : JSON.stringify(failure.body));
      assert.equal(error.headers.get("retry-after"), "23");
      return true;
    });
    assert.equal(calls, 1);
    mocked.mock.restore();
  }
});

test("non-Responses failures translate protocol semantics and preserve provider metadata", () => {
  const cases = [
    { status: 400, type: "invalid_request_error", message: "Prompt is too long", code: "context_length_exceeded" },
    { status: 429, type: "insufficient_quota", message: "Account limit reached", code: "insufficient_quota" },
    { status: 429, type: "rate_limit_error", message: "Too many requests", code: "rate_limit_exceeded" },
    { status: 503, type: "overloaded_error", message: "Busy", code: "server_is_overloaded" },
    { status: 502, type: "provider_new_error", message: "Provider diagnostic", code: "upstream_error" },
  ];
  for (const failure of cases) {
    const payload = { type: "error", error: { type: failure.type, message: failure.message, headers: { "Retry-After": "19" }, param: null, details: ["synthetic-detail"] } };
    for (const status of [failure.status, undefined]) {
      const error = upstreamError(status, payload);
      assert.equal(error.code, failure.code);
      assert.equal(error.status, failure.status);
      assert.equal(error.message, failure.message);
      assert.deepEqual(error.upstream?.body, payload);
      assert.equal(error.upstream?.status, status);
      assert.deepEqual(error.headers, { "retry-after": "19" });
    }
  }
  const error = upstreamError(429, { error: { code: "rate_limit_exceeded", headers: { "retry-after": "10" } } }, new Headers({ "retry-after": "30" }));
  assert.deepEqual(error.headers, { "retry-after": "30" });
});

test("native Responses errors retain their object and only add missing retry advice", () => {
  const original = { code: "future_native_code", message: "Native detail", details: { reason: "synthetic" }, headers: { "Retry-After": "19", "x-request-id": "req_synthetic" } };
  const snapshot = structuredClone(original);
  assert.deepEqual(responsesStreamError({ error: original }, new Headers({ "retry-after": "30" })).error, original);
  const withoutDelay = { ...original, headers: { "x-request-id": "req_synthetic" } };
  assert.deepEqual(responsesStreamError(withoutDelay, new Headers({ "retry-after": "30" })).error, {
    ...withoutDelay, headers: { ...withoutDelay.headers, "retry-after": "30" },
  });
  const noCode = { type: "error", message: "Native error without a code" };
  assert.deepEqual(responsesStreamError(noCode).error, noCode);
  assert.deepEqual(original, snapshot);
});

test("network failures expose the cause and code without request or credential output", async (t) => {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4321"), {
    code: "ECONNREFUSED", request: { headers: { authorization: "synthetic-secret" } },
  });
  const failure = Object.assign(new TypeError("fetch failed", { cause }), {
    stdout: "synthetic-secret", stderr: "synthetic-secret", headers: { authorization: "synthetic-secret" },
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw failure; });
  await assert.rejects(upstreamFetch(route(), "responses", {}, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "upstream_error");
    assert.equal(error.status, 502);
    assert.match(error.message, /fetch failed.*connect ECONNREFUSED/);
    assert.deepEqual(error.cause, {
      name: "TypeError", message: "fetch failed",
      cause: { name: "Error", message: "connect ECONNREFUSED 127.0.0.1:4321", code: "ECONNREFUSED" },
    });
    assert.equal(JSON.stringify(error.cause).includes("synthetic-secret"), false);
    return true;
  });
  assert.equal(calls, 1);
  const classified = new BridgeError("Busy", "server_is_overloaded", 503);
  assert.equal(transportError(classified), classified);
});

test("response body failures retain transport diagnostics instead of discarding them", async (t) => {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError("terminated", { cause })); },
  }), { status: 502 }));
  await assert.rejects(upstreamFetch(route(), "responses", {}, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.match(error.message, /terminated.*other side closed.*UND_ERR_SOCKET/);
    assert.equal(error.code, "upstream_error");
    return true;
  });
});


test("an unsupported context parameter remains a request error, not a full context window", () => {
  const error = upstreamError(400, { error: { type: "invalid_request_error", message: "Unrecognized request argument: context_window" } });
  assert.equal(error.code, "invalid_prompt");
  assert.equal(error.status, 400);
});

test("header and body deadlines can be disabled independently for an embedded transport", async () => {
  const transport: typeof fetch = async (_url, init) => {
    const signal = init!.signal!;
    await delay(30, undefined, { signal });
    return new Response(new ReadableStream({
      start(controller) {
        void delay(30, undefined, { signal }).then(() => {
          controller.enqueue(new TextEncoder().encode("Complete"));
          controller.close();
        }, error => controller.error(error));
      },
    }));
  };
  const selected = route();
  selected.upstream.stream_idle_timeout_ms = 10;
  selected.upstream.headers_timeout_ms = null;
  const response = await upstreamFetch(selected, "responses", {}, new AbortController().signal, undefined, undefined, transport);
  await assert.rejects(response.text(), /Upstream stream timed out/);

  selected.upstream.stream_idle_timeout_ms = null;
  const unlimited = await upstreamFetch(selected, "responses", {}, new AbortController().signal, undefined, undefined, transport);
  assert.equal(await unlimited.text(), "Complete");

  selected.upstream.headers_timeout_ms = 10;
  await assert.rejects(upstreamFetch(selected, "responses", {}, new AbortController().signal, undefined, undefined, transport), /Upstream stream timed out/);
});

test("connection timeout settings accept null and reject invalid durations", () => {
  for (const field of ["headers_timeout_ms", "stream_idle_timeout_ms"]) {
    const configuration = { upstreams: { remote: { base_url: "https://example.com", [field]: null } }, models: {
      test: { upstream: "remote", model: "synthetic", catalog: "gpt-6.1-sol" },
    } };
    assert.doesNotThrow(() => validateConfig(configuration));
    for (const value of [0, -1, false, "30", 1.5]) {
      assert.throws(() => validateConfig({ ...configuration, upstreams: { remote: { ...configuration.upstreams.remote, [field]: value } } }), /timeout_ms/);
    }
  }
});
