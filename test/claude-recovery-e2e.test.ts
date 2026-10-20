import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildAnthropicRequest } from "../src/backends/anthropic.ts";
import { decodeReasoning } from "../src/carrier.ts";
import { configSnippet } from "../src/catalog.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { createBridgeServer } from "../src/server.ts";
import { formatSse } from "../src/sse.ts";
import type { BridgeConfig } from "../src/types.ts";

const run = promisify(execFile);
const binary = process.env.CODEKS_BIN;
const thoughts = [
  { signature: "synthetic-recovery-signature-1", summary: "SYNTHETIC_INTERRUPTED_THINKING" },
  { signature: "synthetic-recovery-signature-2", summary: "SYNTHETIC_RECOVERY_THINKING" },
  { signature: "synthetic-recovery-signature-3", summary: "SYNTHETIC_SECOND_RECOVERY_THINKING" },
];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function event(res: ServerResponse, value: Record<string, unknown>) {
  res.write(formatSse(value, String(value.type)));
}

function start(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  event(res, { type: "message_start", message: {
    id: "msg_synthetic_recovery", type: "message", role: "assistant", content: [],
    usage: { input_tokens: 100, output_tokens: 0 },
  } });
}

function thinking(res: ServerResponse, signature: string, summary: string) {
  event(res, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
  if (summary) event(res, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: summary } });
  event(res, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } });
  event(res, { type: "content_block_stop", index: 0 });
}

function finish(res: ServerResponse, text: string) {
  event(res, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  event(res, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } });
  event(res, { type: "content_block_stop", index: 1 });
  event(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } });
  event(res, { type: "message_stop" });
  res.end();
}

for (const scenario of [
  { failure: "overload", summary: "auto", interruptions: 1 },
  { failure: "truncated stream", summary: "none", interruptions: 1 },
  { failure: "overload", summary: "auto", interruptions: 2 },
] as const) {
  test(`real codeks: Claude preserves ${scenario.interruptions} ${scenario.failure} recovery boundaries with ${scenario.summary} summary across resume`, {
    skip: !binary, timeout: 120_000,
  }, async (t) => {
    const visible = scenario.summary === "auto";
    const failures: unknown[] = [];
    const requests: any[] = [];
    const clientRequests: any[] = [];
    const expectedThoughts = thoughts.slice(0, scenario.interruptions + 1).map(thought => ({
      type: "thinking", thinking: visible ? thought.summary : "", signature: thought.signature,
    }));
    const continuation = { role: "user", content: [{ type: "text", text: "Continue." }] };
    const withoutCacheMarkers = (messages: any[]) => messages.map(message => ({
      role: message.role,
      content: message.content.map(({ cache_control: _cache, ...block }: any) => block),
    }));
    const upstream = createServer(async (req, res) => {
      try {
        assert.equal(req.url, "/v1/messages");
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        assert.equal(body.thinking.block_binding.prefix_mismatch_behavior, "drop_block");
        assert.equal(body.thinking.display, visible ? "summarized" : "omitted");
        assert.ok(String(req.headers["anthropic-beta"]).split(",").includes("thinking-binding-controls-2026-08-01"));

        if (requests.length <= expectedThoughts.length) {
          const attempt = requests.length - 1;
          if (attempt > 0) {
            const expected = expectedThoughts.slice(0, attempt).flatMap(block => [
              { role: "assistant", content: [block] }, continuation,
            ]);
            assert.deepEqual(withoutCacheMarkers(body.messages.slice(-expected.length)), expected,
              "Each retry restores prior continuation boundaries and adds one after the latest durable thinking");
          }
          start(res);
          thinking(res, expectedThoughts[attempt].signature, expectedThoughts[attempt].thinking);
          if (attempt < scenario.interruptions) {
            if (scenario.failure === "overload") {
              event(res, { type: "error", error: { type: "overloaded_error", message: "Synthetic interrupted response" } });
            }
            // EOF without message_stop also follows the same durable thinking item.
            res.end();
          } else finish(res, "RECOVERED_RESPONSE");
          return;
        }
        assert.equal(requests.length, expectedThoughts.length + 1, "The resumed turn needs only one upstream call");
        assert.equal(body.messages.at(-1).role, "user");
        assert.match(JSON.stringify(body.messages.at(-1).content), /NEXT_SYNTHETIC_TURN/);
        const expected = expectedThoughts.flatMap((block, index) => [
          ...(index > 0 ? [continuation] : []),
          { role: "assistant", content: [
            block,
            ...(index === expectedThoughts.length - 1 ? [{ type: "text", text: "RECOVERED_RESPONSE" }] : []),
          ] },
        ]);
        assert.deepEqual(withoutCacheMarkers(body.messages.slice(-expected.length - 1, -1)), expected,
          "Resume must restore the exact signed prefix boundaries; this fixture does not simulate signature validation");
        start(res);
        finish(res, "RESUMED_RESPONSE");
      } catch (error) {
        failures.push(error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Synthetic recovery fixture failed" } }));
      }
    });
    const upstreamPort = await listen(upstream);
    t.after(() => stop(upstream));
    const config: BridgeConfig = {
      upstreams: { test: { base_url: `http://127.0.0.1:${upstreamPort}/v1` } },
      models: { "recovery-probe": { catalog: "claude-sonnet-5-5", upstream: "test", model: "synthetic-deployment" } },
    };
    const bridge = createBridgeServer(config);
    bridge.on("request", (req) => {
      if (req.method !== "POST") return;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try { clientRequests.push(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (error) { failures.push(error); }
      });
    });
    config.port = await listen(bridge);
    t.after(() => stop(bridge));
    const scratch = await mkdtemp(join(tmpdir(), "codeks-claude-recovery-e2e-"));
    t.diagnostic(`Scratch directory: ${scratch}`);
    const home = join(scratch, "home");
    const work = join(scratch, "work");
    await mkdir(home); await mkdir(work);
    await writeFile(join(home, "config.toml"), [
      "check_for_update_on_startup = false",
      `model_reasoning_summary = ${JSON.stringify(scenario.summary)}`,
      configSnippet(config).replace("[model_providers.bridge.capabilities]",
        `request_max_retries = 0\nstream_max_retries = ${scenario.interruptions}\n[model_providers.bridge.capabilities]`),
    ].join("\n"));
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    const invoke = async (resume: boolean) => {
      try {
        const args = resume
          ? ["exec", "resume", "--last", "--skip-git-repo-check", "--json", "NEXT_SYNTHETIC_TURN"]
          : ["exec", "--skip-git-repo-check", "--json", "-C", work, "--", "Return a short greeting."];
        const pending = run(binary!, args, { cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
        pending.child.stdin?.end();
        const { stdout } = await pending;
        await writeFile(join(scratch, resume ? "resume.stdout" : "exec.stdout"), stdout);
        assert.deepEqual(failures, []);
        assert.ok(stdout.split("\n").some(line => line && JSON.parse(line).type === "turn.completed"), stdout);
        return stdout;
      } catch (error) {
        const output = error as { stdout?: string; stderr?: string };
        await writeFile(join(scratch, "failure.txt"), `${output.stdout ?? ""}\n${output.stderr ?? ""}`);
        assert.deepEqual(failures, []);
        throw error;
      }
    };
    const stdout = await invoke(false);
    assert.match(stdout, /RECOVERED_RESPONSE/);
    for (const thought of thoughts.slice(0, expectedThoughts.length)) assert.equal(stdout.includes(thought.summary), visible);
    assert.equal(clientRequests.length, expectedThoughts.length, "codeks performs exactly the requested retries");
    assert.equal(requests.length, clientRequests.length, "bridge never adds an upstream retry");
    for (let index = 1; index < clientRequests.length; index++) {
      assert.equal(clientRequests[index].input.filter((item: any) => item.type === "reasoning").length, index);
    }
    assert.match(await invoke(true), /RESUMED_RESPONSE/);
    assert.equal(clientRequests.length, expectedThoughts.length + 1);
    assert.equal(requests.length, clientRequests.length);
    assert.ok(clientRequests.every(request => !request.input.some((item: any) =>
      item.role === "user" && JSON.stringify(item.content).includes('"Continue."'))),
    "The client replays carriers, not invented user Continue messages");

    const sessions = join(home, "sessions");
    const paths = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith(".jsonl"));
    const records = (await Promise.all(paths.map(path => readFile(join(sessions, path), "utf8"))))
      .flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
    const reasoning = records
      .filter(record => record.type === "response_item" && record.payload.type === "reasoning")
      .map(record => record.payload);
    assert.equal(reasoning.length, expectedThoughts.length);
    const carriers = reasoning.map(item => decodeReasoning(item.encrypted_content) as
      NonNullable<ReturnType<typeof decodeReasoning>> & { continuation_before?: string });
    assert.deepEqual(carriers.map(carrier => carrier.data), expectedThoughts,
      "Signed blocks survive retries and process restart without embedded bridge metadata");
    assert.deepEqual(carriers.map(carrier => carrier.continuation_before),
      expectedThoughts.map((_thought, index) => index > 0 ? "Continue." : undefined));
    assert.deepEqual(reasoning.map(item => item.summary), expectedThoughts.map(block =>
      visible ? [{ type: "summary_text", text: block.thinking }] : []));
    assert.ok(!records.some(record => record.type === "response_item" &&
      record.payload.role === "user" && JSON.stringify(record.payload.content).includes('"Continue."')));
  });
}

test("Claude recovery leaves unanswered tool calls for the upstream to reject", () => {
  const config = validateConfig({
    upstreams: { test: { base_url: "https://api.example.com/v1" } },
    models: { test: { catalog: "claude-sonnet-5-5", upstream: "test", model: "synthetic-deployment" } },
  });
  const { body } = buildAnthropicRequest({
    route: resolveModel(config, "test"), signal: new AbortController().signal,
    request: {
      model: "test",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
      input: [
        { type: "message", role: "user", content: "Look up the value." },
        { type: "function_call", call_id: "synthetic_unanswered_call", name: "lookup", arguments: "{}" },
      ],
    },
  });
  assert.equal(body.messages.at(-1).role, "assistant");
  assert.deepEqual(body.messages.at(-1).content, [{
    type: "tool_use", id: "synthetic_unanswered_call", name: "lookup", input: {},
  }], "Recovery must not mask a missing tool result with Continue or an invented result");
});
