import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { decodeReasoning } from "../src/carrier.ts";
import { configSnippet } from "../src/catalog.ts";
import { createBridgeServer } from "../src/server.ts";
import { formatSse } from "../src/sse.ts";
import type { BridgeConfig } from "../src/types.ts";

const run = promisify(execFile);
const binary = process.env.CODEKS_BIN;
const summaryText = "SYNTHETIC_VISIBLE_REASONING";
const proactiveHint = "Proactive multi-agent delegation is active.";

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

function reply(res: ServerResponse, chat: boolean, showSummary: boolean) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (chat) {
    res.write(formatSse({ choices: [{ index: 0, delta: { reasoning_content: summaryText }, finish_reason: null }] }));
    res.write(formatSse({ choices: [{ index: 0, delta: { content: "REASONING_DONE" }, finish_reason: null }] }));
    res.write(formatSse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    res.write(formatSse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 12 } }));
    res.end("data: [DONE]\n\n");
    return;
  }
  const events = [
    { type: "message_start", message: { id: "msg_synthetic_reasoning", type: "message", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    ...(showSummary ? [{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: summaryText } }] : []),
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "synthetic-thinking-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "REASONING_DONE" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
    { type: "message_stop" },
  ];
  for (const event of events) res.write(formatSse(event, event.type));
  res.end();
}

const cases = [
  { catalog: "claude-opus-5-5", summary: undefined, effort: "xhigh" },
  { catalog: "claude-opus-5-5", summary: "none", effort: "xhigh" },
  { catalog: "claude-sonnet-5-5", summary: "auto", effort: "max" },
  { catalog: "deepseek-flash", summary: "detailed", effort: "max" },
] as const;

for (const scenario of cases) {
  test(`real codeks: ${scenario.catalog} Ultra with ${scenario.summary ?? "catalog default"} summary`, {
    skip: !binary, timeout: 120_000,
  }, async (t) => {
    const chat = scenario.catalog === "deepseek-flash";
    const visible = scenario.summary === "auto" || scenario.summary === "detailed";
    const failures: unknown[] = [];
    const requests: any[] = [];
    const clientRequests: any[] = [];
    const upstream = createServer(async (req, res) => {
      try {
        assert.equal(req.url, chat ? "/v1/chat/completions" : "/v1/messages");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        assert.equal(chat ? body.reasoning_effort : body.output_config.effort, scenario.effort);
        if (!chat) assert.deepEqual(body.thinking, { type: "adaptive", display: visible ? "summarized" : "omitted" });
        const prompt = JSON.stringify({ system: body.system, messages: body.messages });
        assert.equal(prompt.split(proactiveHint).length - 1, 1, "The adapter must preserve, not duplicate, Codex's Ultra hint");
        reply(res, chat, visible);
      } catch (error) {
        failures.push(error);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Synthetic reasoning assertion failed" } }));
      }
    });
    const upstreamPort = await listen(upstream);
    t.after(() => stop(upstream));
    const config: BridgeConfig = {
      upstreams: { test: { base_url: `http://127.0.0.1:${upstreamPort}/v1` } },
      models: { "reasoning-probe": { catalog: scenario.catalog, upstream: "test", model: "synthetic-deployment" } },
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
    const scratch = await mkdtemp(join(tmpdir(), "codeks-reasoning-e2e-"));
    t.diagnostic(`Scratch directory: ${scratch}`);
    const home = join(scratch, "home");
    const work = join(scratch, "work");
    await mkdir(home); await mkdir(work);
    await writeFile(join(home, "config.toml"), [
      "check_for_update_on_startup = false",
      'model_reasoning_effort = "ultra"',
      ...(scenario.summary === undefined ? [] : [`model_reasoning_summary = ${JSON.stringify(scenario.summary)}`]),
      configSnippet(config).replace("[model_providers.bridge.capabilities]", "request_max_retries = 0\nstream_max_retries = 0\n[model_providers.bridge.capabilities]"),
    ].join("\n"));
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    let stdout: string;
    try {
      const pending = run(binary!, ["exec", "--skip-git-repo-check", "--json", "-C", work, "--", "Return REASONING_DONE."], {
        cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
      });
      pending.child.stdin?.end();
      ({ stdout } = await pending);
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      await writeFile(join(scratch, "failure.txt"), `${output.stdout ?? ""}\n${output.stderr ?? ""}`);
      assert.deepEqual(failures, []);
      throw error;
    }
    assert.deepEqual(failures, []);
    assert.equal(requests.length, 1);
    assert.equal(clientRequests.length, 1);
    assert.equal(clientRequests[0].reasoning.effort, scenario.effort, "Codex normalizes Ultra before sending the request");
    assert.equal(clientRequests[0].reasoning.summary, visible ? scenario.summary : undefined, "Codex omits summary for none and for this catalog's default");
    assert.match(JSON.stringify(clientRequests[0].input), /<multi_agent_mode>Proactive multi-agent delegation is active\./);
    assert.match(stdout, /REASONING_DONE/);
    assert.equal(stdout.includes(summaryText), visible);

    // Even with no visible summary, the real client's rollout must retain the signed state.
    const sessions = join(home, "sessions");
    const paths = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith(".jsonl"));
    const records = (await Promise.all(paths.map(path => readFile(join(sessions, path), "utf8"))))
      .flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
    const items = records.filter(record => record.type === "response_item" && record.payload.type === "reasoning").map(record => record.payload);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].summary, visible ? [{ type: "summary_text", text: summaryText }] : []);
    const state = decodeReasoning(items[0].encrypted_content);
    assert.ok(state, "The client persists the bridge carrier regardless of summary visibility");
    if (chat) assert.equal(state.data, summaryText);
    else assert.deepEqual(state.data, { type: "thinking", thinking: visible ? summaryText : "", signature: "synthetic-thinking-signature" });
  });
}
