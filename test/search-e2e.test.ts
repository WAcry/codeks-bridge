import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { configSnippet } from "../src/catalog.ts";
import { createBridgeServer } from "../src/server.ts";
import { formatSse } from "../src/sse.ts";
import type { BridgeConfig } from "../src/types.ts";

const run = promisify(execFile);
const binary = process.env.CODEKS_BIN;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function message(block: Record<string, unknown>, stopReason: "tool_use" | "end_turn"): Response {
  const events = [
    { type: "message_start", message: {
      id: "msg_synthetic_search", type: "message", role: "assistant", content: [],
      usage: { input_tokens: 100, output_tokens: 0 },
    } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 12 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => formatSse(event, event.type)).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("real codeks: Claude Code Mode shares subscription search, open and click results", {
  skip: !binary, timeout: 120_000,
}, async t => {
  const scratch = await mkdtemp(join(tmpdir(), "codeks-search-e2e-"));
  t.diagnostic(`Scratch directory: ${scratch}`);
  const home = join(scratch, "home");
  const work = join(scratch, "work");
  const subscription = join(scratch, "subscription");
  await Promise.all([mkdir(home), mkdir(work), mkdir(subscription)]);
  const token = `synthetic.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString("base64url")}.signature`;
  await writeFile(join(subscription, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
    tokens: { access_token: token, refresh_token: "synthetic-refresh", account_id: "synthetic-account" },
  }), { mode: 0o600 });
  const config: BridgeConfig = {
    web_search: { upstream: "subscription" },
    upstreams: {
      messages: { base_url: "https://messages.example/v1" },
      subscription: { base_url: "https://subscription.example/backend-api/codex", auth: { type: "chatgpt", codex_home: subscription } },
    },
    models: { "claude-work": { catalog: "claude-sonnet-5-5", upstream: "messages", model: "synthetic-claude-deployment" } },
  };
  const failures: unknown[] = [];
  const modelRequests: any[] = [];
  const searchRequests: any[] = [];
  const commands = [
    { search_query: [{ q: "synthetic search" }], response_length: "short" },
    { open: [{ ref_id: "turn0search0" }], response_length: "short" },
    { click: [{ ref_id: "turn1view0", id: 7 }], response_length: "short" },
  ];
  const outputs = ["SEARCH_PLAINTEXT_SENTINEL", "OPEN_PLAINTEXT_SENTINEL", "CLICK_PLAINTEXT_SENTINEL"];
  const bridge = createBridgeServer(config, { fetch: async (url, init) => {
    try {
      const body = JSON.parse(String(init?.body));
      if (String(url) === "https://subscription.example/backend-api/codex/alpha/search") {
        const index = searchRequests.length;
        searchRequests.push(body);
        assert.equal(body.model, "claude-work", "Search preserves the client model alias without selecting a GPT model");
        assert.deepEqual(body.commands, commands[index]);
        assert.deepEqual(body.settings, { allowed_callers: ["direct"], external_web_access: true });
        assert.equal(typeof body.id, "string");
        assert.ok(body.id.length > 0);
        assert.equal(body.id, searchRequests[0].id, "References remain in the same search session");
        assert.match(JSON.stringify(body.input), /SYNTHETIC_SEARCH_TASK/);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), `Bearer ${token}`);
        assert.equal(headers.get("chatgpt-account-id"), "synthetic-account");
        assert.equal(headers.get("anthropic-version"), null, "Search does not inherit the working model's protocol headers");
        return Response.json({
          output: outputs[index], encrypted_output: `synthetic-search-ciphertext-${index}`,
          results: [{ type: "text_result", ref_id: index === 0 ? "turn0search0" : `turn${index}view0`, url: "https://example.com/result" }],
        });
      }
      assert.equal(String(url), "https://messages.example/v1/messages", "All upstream calls must stay inside the synthetic fixture");
      modelRequests.push(body);
      assert.equal(body.model, "synthetic-claude-deployment");
      if (modelRequests.length === 1) {
        const exec = body.tools.find((tool: any) => tool.name === "exec" || tool.name.endsWith("__exec"));
        assert.ok(exec, "The catalog enables Code Mode without a tool-mode override");
        return message({ type: "tool_use", id: "synthetic_search_exec", name: exec.name, input: {
          input: commands.map(command => `text(await tools.web__run(${JSON.stringify(command)}));`).join("\n"),
        } }, "tool_use");
      }
      assert.equal(modelRequests.length, 2, "The search operations do not require an extra model request");
      const result = body.messages.flatMap((item: any) => item.content)
        .find((block: any) => block.type === "tool_result" && block.tool_use_id === "synthetic_search_exec");
      assert.ok(result, "The Code Mode result must reach Claude as an ordinary tool result");
      for (const output of outputs) assert.ok(JSON.stringify(result).includes(output));
      assert.doesNotMatch(JSON.stringify(body.messages), /synthetic-search-ciphertext/);
      return message({ type: "text", text: "SEARCH_DONE" }, "end_turn");
    } catch (error) {
      failures.push(error);
      return Response.json({ error: { message: "Synthetic search fixture failed" } }, { status: 500 });
    }
  } });
  config.port = await listen(bridge);
  t.after(() => stop(bridge));
  await writeFile(join(home, "config.toml"), [
    "check_for_update_on_startup = false",
    configSnippet(config).replace("[model_providers.bridge.capabilities]",
      "request_max_retries = 0\nstream_max_retries = 0\n[model_providers.bridge.capabilities]"),
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  try {
    const pending = run(binary!, ["exec", "--skip-git-repo-check", "--json", "-C", work, "--",
      "SYNTHETIC_SEARCH_TASK: search, open the result and click its link using Code Mode."], {
      cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    await writeFile(join(scratch, "exec.stdout"), stdout);
    assert.deepEqual(failures, []);
    assert.match(stdout, /SEARCH_DONE/);
    assert.ok(stdout.split("\n").some(line => line && JSON.parse(line).type === "turn.completed"), stdout);
    assert.equal(modelRequests.length, 2);
    assert.equal(searchRequests.length, 3);
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    await writeFile(join(scratch, "failure.txt"), `${output.stdout ?? ""}\n${output.stderr ?? ""}`);
    assert.deepEqual(failures, []);
    throw error;
  }
});
