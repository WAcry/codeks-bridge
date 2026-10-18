import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { formatSse } from "../src/sse.ts";
import { SUMMARIZATION_PROMPT } from "../src/prompts.ts";
import { buildCatalog, readBundledCatalog } from "../src/catalog.ts";
import type { BridgeConfig } from "../src/types.ts";

const run = promisify(execFile);
const binary = process.env.CODEKS_BIN;
let bundled: Promise<any> | undefined;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1`;
}

function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

type Call = { name: string; args: Record<string, unknown>; id?: string };
type Reply = { text?: string; calls?: Call[]; tokens?: number };

function sendChat(res: ServerResponse, reply: Reply) {
  const calls = reply.calls ?? [];
  const content = reply.text ?? "";
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Synthetic reasoning." }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {
      ...(content ? { content } : {}),
      ...(calls.length ? { tool_calls: calls.map((call, index) => ({
        index, id: call.id ?? `call_synthetic_${index}`, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })) } : {}),
    }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] },
    { choices: [], usage: { prompt_tokens: reply.tokens ?? 100, completion_tokens: 12, prompt_cache_hit_tokens: 50 } },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) res.write(formatSse({ id: "chat_synthetic", object: "chat.completion.chunk", ...chunk }));
  res.end("data: [DONE]\n\n");
}

async function fixture(t: TestContext, template: string, respond: (body: any, index: number) => Reply, compactLimit?: number) {
  const requests: any[] = [];
  const failures: unknown[] = [];
  const upstream = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const body = JSON.parse(Buffer.concat(parts).toString());
      requests.push(body);
      sendChat(res, respond(body, requests.length));
    } catch (error) {
      failures.push(error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Synthetic upstream assertion failed" } }));
    }
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => stop(upstream));
  const { createBridgeServer } = await import("../src/server.ts");
  const config: BridgeConfig = {
    upstreams: { fake: { base_url: upstreamUrl } },
    models: { "test-model": { adapter: "deepseek-chat", upstream: "fake", model: "test-model", context_window: 272_000, max_output_tokens: 4096 } },
  };
  const bridge = createBridgeServer(config);
  const bridgeUrl = await listen(bridge);
  t.after(() => stop(bridge));
  const scratch = await mkdtemp(join(tmpdir(), "codeks-bridge-e2e-"));
  const home = join(scratch, "home");
  const work = join(scratch, "work");
  await mkdir(home);
  await mkdir(work);
  // Keep this disposable directory for diagnosing a failed real-process run.
  t.diagnostic(`Scratch directory: ${scratch}`);
  bundled ??= readBundledCatalog(binary!);
  const catalog = buildCatalog(config, await bundled, template);
  assert.equal(catalog.models[0].use_responses_lite, false);
  if (compactLimit) catalog.models[0].auto_compact_token_limit = compactLimit;
  const modelsPath = join(home, "models.json");
  await writeFile(modelsPath, JSON.stringify(catalog));
  await writeFile(join(home, "config.toml"), `
model_provider = "bridge"
model = "test-model"
model_catalog_json = ${JSON.stringify(modelsPath)}
web_search = "disabled"
check_for_update_on_startup = false
[model_providers.bridge]
name = "codeks-bridge"
base_url = ${JSON.stringify(bridgeUrl)}
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[model_providers.bridge.capabilities]
remote_compaction = "v2"
`);
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
  delete env.OPENAI_API_KEY;
  const invoke = async (prompt: string, resume = false, images: string[] = []) => {
    try {
      const args = resume
        ? ["exec", "resume", "--last", "--skip-git-repo-check", "--json", prompt]
        : ["exec", "--skip-git-repo-check", "-C", work, "--json", "-s", "workspace-write", ...images.flatMap(path => ["--image", path]), "--", prompt];
      const pending = run(binary!, args, { cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
      pending.child.stdin?.end();
      const result = await pending;
      assert.deepEqual(failures, [], "fake upstream assertions");
      await writeFile(join(scratch, resume ? "resume.stdout" : "exec.stdout"), result.stdout);
      return result.stdout;
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      await writeFile(join(scratch, "failure.txt"), `${output.stdout ?? ""}\n${output.stderr ?? ""}`);
      assert.deepEqual(failures, [], "fake upstream assertions");
      throw error;
    }
  };
  return { requests, invoke, work };
}

function findTool(body: any, name: string): string {
  const tool = body.tools?.find((tool: any) => tool.function.name === name || tool.function.name.endsWith(`__${name}`));
  assert.ok(tool, `Missing converted tool ${name}`);
  return tool.function.name;
}

function toolReply(body: any, id: string): any {
  return body.messages.find((message: any) => message.role === "tool" && message.tool_call_id === id);
}

const pixel = "89504e470d0a1a0a0000000d4948445200000004000000040802000000269309290000001049444154789c63f8cfc000470cc47100ae930ff1d05f239e0000000049454e44ae426082";

test("real codeks: function/custom tools execute and image results reach Chat", { skip: !binary, timeout: 120_000 }, async (t) => {
  const { requests, invoke, work } = await fixture(t, "gpt-5.5", (body, index) => {
    if (index === 1) {
      assert.ok(body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === "image_url")));
      return { calls: [
      { name: findTool(body, "exec_command"), id: "call_exec", args: { cmd: "echo bridge-tool-ok", yield_time_ms: 1000 } },
      { name: findTool(body, "apply_patch"), id: "call_patch", args: { input: "*** Begin Patch\n*** Add File: notes.txt\n+bridge patch ok\n*** End Patch\n" } },
    ] };
    }
    if (index === 2) {
      assert.match(JSON.stringify(toolReply(body, "call_exec")), /bridge-tool-ok/);
      assert.ok(toolReply(body, "call_patch"));
      return { calls: [{ name: findTool(body, "view_image"), id: "call_image", args: { path: "pixel.png" } }] };
    }
    assert.ok(toolReply(body, "call_image"));
    const images = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((part: any) => part.type === "image_url");
    assert.equal(images.length, 2, "Both the attached image and the tool image must be present");
    return { text: "ALL_TOOLS_DONE" };
  });
  await writeFile(join(work, "pixel.png"), Buffer.from(pixel, "hex"));
  const stdout = await invoke("Run echo, create notes.txt, and inspect pixel.png.", false, [join(work, "pixel.png")]);
  assert.match(stdout, /ALL_TOOLS_DONE/);
  assert.equal(await readFile(join(work, "notes.txt"), "utf8"), "bridge patch ok\n");
  assert.equal(requests.length, 3);
  assert.equal(requests[1].messages.find((message: any) => message.role === "assistant").reasoning_content, "Synthetic reasoning.");
});

test("real codeks: code mode and plaintext multi-agent v2 calls round-trip", { skip: !binary, timeout: 120_000 }, async (t) => {
  let parentStep = 0;
  let children = 0;
  const { requests, invoke } = await fixture(t, "gpt-6-sol", (body) => {
    if (!JSON.stringify(body.messages).includes("ROOT_SYNTHETIC_TASK")) {
      children++;
      assert.match(JSON.stringify(body.messages), /CHILD_SYNTHETIC_TASK/);
      return { text: "CHILD_DONE" };
    }
    parentStep++;
    if (parentStep === 1) return { calls: [{
      name: findTool(body, "exec"), id: "call_code", args: { input: 'text(await tools.exec_command({cmd: "echo code-mode-ok", yield_time_ms: 1000}));' },
    }] };
    if (parentStep === 2) {
      assert.match(JSON.stringify(toolReply(body, "call_code")), /code-mode-ok/);
      const name = findTool(body, "spawn_agent");
      assert.match(name, /__/);
      const definition = body.tools.find((tool: any) => tool.function.name === name);
      assert.equal(definition.function.parameters.properties.message.encrypted, undefined);
      return { calls: [{ name, id: "call_spawn", args: { task_name: "synthetic_child", message: "CHILD_SYNTHETIC_TASK: return CHILD_DONE.", fork_turns: "none" } }] };
    }
    if (parentStep === 3) {
      const result = toolReply(body, "call_spawn");
      assert.ok(result);
      assert.doesNotMatch(JSON.stringify(result), /encrypted.*required|failed|unknown tool/i);
      return { calls: [{ name: findTool(body, "wait_agent"), id: "call_wait", args: { timeout_ms: 10_000 } }] };
    }
    assert.match(JSON.stringify(body.messages), /Message Type: FINAL_ANSWER/);
    return { text: "PARENT_DONE" };
  });
  const stdout = await invoke("ROOT_SYNTHETIC_TASK: run echo, then ask one child to return CHILD_DONE and wait for it.");
  assert.match(stdout, /PARENT_DONE/);
  assert.ok(children >= 1, "A real child request must reach the upstream");
  assert.ok(requests.length >= 5);
});

test("real codeks: remote compaction V2 replaces history and survives resume", { skip: !binary, timeout: 120_000 }, async (t) => {
  let normal = 0;
  let summaries = 0;
  const { requests, invoke } = await fixture(t, "gpt-5.5", (body) => {
    if (body.tool_choice === "none" && body.messages.some((message: any) => message.content === SUMMARIZATION_PROMPT)) {
      summaries++;
      assert.ok(toolReply(body, "call_before_compact"));
      assert.ok(body.tools.length > 0, "Summary requests keep the tool prefix");
      return { text: "CHECKPOINT_SUMMARY: The command printed compact-tool-ok." };
    }
    normal++;
    if (normal === 1) return { tokens: 40_000, calls: [{
      name: findTool(body, "exec_command"), id: "call_before_compact", args: { cmd: "echo compact-tool-ok", yield_time_ms: 1000 },
    }] };
    assert.match(JSON.stringify(body.messages), /CHECKPOINT_SUMMARY/);
    assert.equal(body.messages.some((message: any) => message.role === "tool"), false);
    return { text: normal === 2 ? "COMPACTION_DONE" : "RESUME_DONE" };
  }, 30_000);
  assert.match(await invoke("Run echo before compaction."), /COMPACTION_DONE/);
  assert.match(await invoke("Continue after restarting the client.", true), /RESUME_DONE/);
  assert.equal(summaries, 1);
  assert.equal(requests.length, 4);
});
