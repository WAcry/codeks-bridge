import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { configSnippet } from "../src/catalog.ts";
import { createBridgeServer } from "../src/server.ts";
import { formatSse } from "../src/sse.ts";
import type { BridgeConfig } from "../src/types.ts";

const run = promisify(execFile);
const binary = process.env.CODEKS_BIN;
const usage = {
  input_tokens: 1111, output_tokens: 222, total_tokens: 1333,
  input_tokens_details: { cached_tokens: 17 }, output_tokens_details: { reasoning_tokens: 34 },
};

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

async function fixture(t: TestContext, catalog: "gpt-6.1-sol" | "gpt-6.1-terra" | "deepseek-flash", reply: (body: any, index: number) => unknown[]) {
  const requests: any[] = [];
  const clientRequests: any[] = [];
  const failures: unknown[] = [];
  const upstream = createServer(async (req, res) => {
    try {
      assert.equal(req.url, catalog === "deepseek-flash" ? "/v1/chat/completions" : "/v1/responses");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const events = reply(body, requests.length);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map(event => formatSse(event)).join(""));
    } catch (error) {
      failures.push(error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Synthetic protocol fixture failed" } }));
    }
  });
  const upstreamPort = await listen(upstream);
  t.after(() => stop(upstream));
  const config: BridgeConfig = {
    upstreams: { test: { base_url: `http://127.0.0.1:${upstreamPort}/v1` } },
    models: { "protocol-probe": { catalog, upstream: "test", model: "synthetic-deployment" } },
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
  const scratch = await mkdtemp(join(tmpdir(), "codeks-protocol-e2e-"));
  t.diagnostic(`Scratch directory: ${scratch}`);
  const home = join(scratch, "home");
  const work = join(scratch, "work");
  await mkdir(home); await mkdir(work);
  await writeFile(join(home, "config.toml"), [
    "check_for_update_on_startup = false",
    configSnippet(config).replace("[model_providers.bridge.capabilities]", "request_max_retries = 0\nstream_max_retries = 0\n[model_providers.bridge.capabilities]"),
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  const invoke = async (options: string[] = []) => {
    let stdout = "";
    let code: unknown = 0;
    try {
      const pending = run(binary!, ["exec", "--skip-git-repo-check", "--json", "-C", work, ...options, "--", "Complete the synthetic protocol task."], {
        cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
      });
      pending.child.stdin?.end();
      ({ stdout } = await pending);
    } catch (cause) {
      const error = cause as { code?: unknown; stdout?: string; stderr?: string };
      code = error.code;
      stdout = error.stdout ?? "";
      await writeFile(join(scratch, "failure.txt"), `${stdout}\n${error.stderr ?? ""}`);
    }
    assert.deepEqual(failures, []);
    assert.equal(requests.length, clientRequests.length, "Every client request makes one upstream attempt");
    return { code, events: stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
  };
  const records = async () => {
    const sessions = join(home, "sessions");
    const paths = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith(".jsonl"));
    return (await Promise.all(paths.map(path => readFile(join(sessions, path), "utf8"))))
      .flatMap(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
  };
  const discover = async () => {
    const pending = run(binary!, ["debug", "models"], { cwd: work, env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    pending.child.stdin?.end();
    return JSON.parse((await pending).stdout);
  };
  return { requests, clientRequests, invoke, records, discover };
}

function responseEvents(text: string, reason?: string): unknown[] {
  const item = {
    type: "message", id: `msg_synthetic_${reason ?? "complete"}`, role: "assistant", status: "completed",
    phase: reason === "interrupted" ? "commentary" : "final_answer",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: reason ? "response.incomplete" : "response.completed",
      response: {
        id: reason ? "resp_synthetic_incomplete" : "resp_synthetic_complete",
        status: reason ? "incomplete" : "completed", output: [item], usage,
        ...(reason ? { incomplete_details: { reason } } : { end_turn: true }),
      },
    },
  ];
}

test("real codeks: GPT-6.1 Terra is discovered and runs with its own window and Ultra defaults", { skip: !binary, timeout: 120_000 }, async (t) => {
  const { requests, clientRequests, discover, invoke } = await fixture(t, "gpt-6.1-terra", () => responseEvents("TERRA_COMPLETE"));
  const { models } = await discover();
  assert.equal(models.length, 1);
  assert.equal(models[0].slug, "protocol-probe");
  assert.equal(models[0].context_window, 500000);
  assert.equal(models[0].max_context_window, 872000);
  assert.equal(models[0].multi_agent_reasoning_effort, "xhigh");
  for (const options of [[], ["-c", 'model_reasoning_effort="ultra"']]) {
    const result = await invoke(options);
    assert.equal(result.code, 0);
    assert.ok(result.events.some(event => event.type === "turn.completed"));
  }
  assert.deepEqual(requests.map(request => request.reasoning.effort), ["low", "xhigh"]);
  assert.ok(requests.every(request => request.model === "synthetic-deployment" && request.reasoning.context === "all_turns"));
  assert.ok(clientRequests.every(request => request.tools === undefined && request.input.some((item: any) =>
    item.type === "additional_tools" && item.tools.some((tool: any) =>
      tool.type === "namespace" && tool.tools.some((member: any) => member.type === "custom" && member.name === "exec")))));
  assert.match(JSON.stringify(clientRequests[1].input), /<multi_agent_mode>Proactive multi-agent delegation is active\./);
});

test("real codeks: native interrupted response continues with the delivered history", { skip: !binary, timeout: 120_000 }, async (t) => {
  const { requests, invoke } = await fixture(t, "gpt-6.1-sol", (_body, index) => index === 1
    ? responseEvents("INTERRUPTED_PROGRESS", "interrupted")
    : responseEvents("CONTINUATION_DONE"));
  const result = await invoke();
  assert.equal(result.code, 0);
  assert.equal(requests.length, 2, "Interrupted means a follow-up even with client retries disabled");
  assert.ok(JSON.stringify(requests[1].input).includes("INTERRUPTED_PROGRESS"));
  assert.ok(result.events.some(event => event.type === "turn.completed"));
  assert.ok(!result.events.some(event => event.type === "turn.failed"));
  assert.ok(JSON.stringify(result.events).includes("CONTINUATION_DONE"));
});

test("real codeks: terminal-only incomplete SSE retains text and reasoning for continuation", { skip: !binary, timeout: 120_000 }, async (t) => {
  const reasoning = { type: "reasoning", id: "rs_synthetic_partial", summary: [], encrypted_content: "synthetic-partial-cipher" };
  const terminal = responseEvents("TERMINAL_ONLY_PROGRESS", "interrupted").at(-1) as any;
  terminal.response.output.unshift(reasoning);
  const { requests, invoke } = await fixture(t, "gpt-6.1-sol", (_body, index) => index === 1
    ? [terminal] : responseEvents("TERMINAL_ONLY_CONTINUED"));
  const result = await invoke();
  assert.equal(result.code, 0);
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[1].input).includes("TERMINAL_ONLY_PROGRESS"));
  assert.ok(requests[1].input.some((item: any) => item.type === "reasoning" && item.encrypted_content === reasoning.encrypted_content));
  assert.ok(result.events.some(event => event.type === "turn.completed"));
});

test("real codeks: malformed completed usage does not execute a held tool", { skip: !binary, timeout: 120_000 }, async (t) => {
  const call = {
    type: "custom_tool_call", id: "ctc_synthetic_held", call_id: "call_synthetic_held", namespace: "functions", name: "exec",
    input: 'text("SYNTHETIC_TOOL_EXECUTED");',
  };
  for (const validUsage of [false, true]) {
    const { requests, invoke, records } = await fixture(t, "gpt-6.1-sol", (_body, index) => index === 1 ? [
      { type: "response.output_item.added", output_index: 0, item: call },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: {
        id: "resp_synthetic_tool", status: "completed", output: [call], end_turn: false,
        usage: validUsage ? usage : { input_tokens: 10, output_tokens: 2 },
      } },
    ] : responseEvents("TOOL_CONTROL_COMPLETE"));
    const result = await invoke();
    const outputs = (await records()).filter(record => record.type === "response_item" &&
      record.payload.type === "custom_tool_call_output" && record.payload.call_id === call.call_id);
    if (validUsage) {
      assert.equal(result.code, 0);
      assert.equal(requests.length, 2);
      assert.equal(outputs.length, 1, "The positive control must execute the same valid tool call");
      assert.ok(JSON.stringify(outputs).includes("SYNTHETIC_TOOL_EXECUTED"));
    } else {
      assert.equal(result.code, 1);
      assert.equal(requests.length, 1);
      assert.equal(outputs.length, 0, "No queued tool may execute before a malformed terminal response fails");
      assert.match(result.events.find(event => event.type === "turn.failed")?.error.message ?? "", /total_tokens/);
    }
  }
});

test("real codeks: native output limit retains spending and ends the turn", { skip: !binary, timeout: 120_000 }, async (t) => {
  const { requests, invoke, records } = await fixture(t, "gpt-6.1-sol", () => responseEvents("PARTIAL_LIMIT_OUTPUT", "max_output_tokens"));
  const result = await invoke();
  assert.equal(result.code, 1);
  assert.equal(requests.length, 1);
  const failed = result.events.find(event => event.type === "turn.failed");
  assert.ok(failed);
  assert.match(failed.error.message, /max_output_tokens/);
  const counts = (await records()).filter(record => record.type === "event_msg" && record.payload.type === "token_count");
  assert.ok(counts.some(record => {
    const total = record.payload.info?.total_token_usage;
    return total?.input_tokens === usage.input_tokens && total.output_tokens === usage.output_tokens &&
      total.cached_input_tokens === 17 && total.reasoning_output_tokens === 34 && total.total_tokens === usage.total_tokens;
  }), "The client must account for the incomplete response's reported tokens");
});

test("real codeks: exec notify keeps every output with one paired Chat result", { skip: !binary, timeout: 120_000 }, async (t) => {
  const { requests, clientRequests, invoke } = await fixture(t, "deepseek-flash", (body, index) => {
    const tool = body.tools.find((entry: any) => entry.function.name.endsWith("__exec") || entry.function.name === "exec");
    assert.ok(tool, "The real catalog must expose Code Mode exec");
    const delta = index === 1 ? { tool_calls: [{
      index: 0, id: "call_synthetic_notify", type: "function", function: {
        name: tool.function.name,
        arguments: JSON.stringify({ input: 'notify("FIRST_NOTIFY"); notify("SECOND_NOTIFY"); text("FINAL_TOOL_OUTPUT");' }),
      },
    }] } : { content: "NOTIFY_COMPLETE" };
    return [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: index === 1 ? "tool_calls" : "stop" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, prompt_cache_hit_tokens: 50 } },
    ];
  });
  const result = await invoke();
  assert.equal(result.code, 0);
  assert.equal(requests.length, 2);
  const outputs = clientRequests[1].input.filter((item: any) => item.type === "custom_tool_call_output" && item.call_id === "call_synthetic_notify");
  assert.equal(outputs.length, 3, "Real exec emits its result and both notifications with the original call ID");
  const messages = requests[1].messages;
  assert.equal(messages.filter((message: any) => message.role === "tool" && message.tool_call_id === "call_synthetic_notify").length, 1);
  for (const marker of ["FIRST_NOTIFY", "SECOND_NOTIFY", "FINAL_TOOL_OUTPUT"]) {
    assert.ok(JSON.stringify(messages).includes(marker), `Missing output: ${marker}`);
  }
  assert.ok(result.events.some(event => event.type === "turn.completed"));
});
