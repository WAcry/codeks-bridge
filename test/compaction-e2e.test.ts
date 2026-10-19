import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { buildCatalog } from "../src/catalog.ts";
import { decodeCompaction } from "../src/carrier.ts";
import { HANDOFF_PROMPT } from "../src/prompts.ts";
import { createBridgeServer } from "../src/server.ts";
import { formatSse } from "../src/sse.ts";
import type { BridgeConfig } from "../src/types.ts";

const run = promisify(execFile);
const binary = process.env.CODEKS_BIN;
const original = "RETAINED_USER_TASK: print the synthetic checkpoint marker.";
const later = "POST_CHECKPOINT_WORK: continue the same task.";
const switched = "SWITCHED_MODEL_TASK: use the checkpoint to finish.";

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
  return new Promise(resolve => server.close(() => resolve()));
}

function native(res: ServerResponse, output: any[], tokens = 100) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(formatSse({ type: "response.completed", response: {
    id: "resp_synthetic", status: "completed", output,
    usage: { input_tokens: tokens, output_tokens: 12, total_tokens: tokens + 12 },
  } }));
}

const reply = (text: string) => ({
  type: "message", role: "assistant", id: "msg_synthetic", status: "completed", phase: "final_answer",
  content: [{ type: "output_text", text }],
});

async function fixture(t: TestContext) {
  const scratch = await mkdtemp(join(tmpdir(), "bridge-native-compaction-"));
  const home = join(scratch, "home");
  const work = join(scratch, "work");
  await Promise.all([mkdir(home), mkdir(work)]);
  t.diagnostic(`Scratch directory: ${scratch}`);
  const upstreamRequests: { path: string; body: any }[] = [];
  const clientRequests: any[] = [];
  const failures: unknown[] = [];
  let normal = 0;
  const upstream = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      upstreamRequests.push({ path: req.url!, body });
      if (req.url === "/v1/chat/completions") {
        assert.match(JSON.stringify(body.messages), /CHECKPOINT_HANDOFF/);
        assert.match(JSON.stringify(body.messages), /POST_CHECKPOINT_WORK/);
        assert.match(JSON.stringify(body.messages), /SWITCHED_MODEL_TASK/);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(formatSse({ choices: [{ index: 0, delta: { content: "TARGET_DONE" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 12 } }) + "data: [DONE]\n\n");
        return;
      }
      assert.equal(req.url, "/v1/responses");
      assert.equal(req.headers["x-openai-internal-codex-responses-lite"], "true");
      const input = body.input as any[];
      if (input.at(-1)?.type === "compaction_trigger") {
        assert.match(JSON.stringify(input), /CHECKPOINT_TOOL_MARKER/);
        native(res, [{ type: "compaction", id: "cmp_native", encrypted_content: "synthetic-native-checkpoint" }]);
      } else if (input.at(-1)?.content?.[0]?.text === HANDOFF_PROMPT) {
        assert.equal(body.tool_choice, "none");
        assert.ok(input.some(item => item.type === "compaction" && item.encrypted_content === "synthetic-native-checkpoint"));
        assert.match(JSON.stringify(input), /RETAINED_USER_TASK/);
        assert.doesNotMatch(JSON.stringify(input), /POST_CHECKPOINT_WORK|SWITCHED_MODEL_TASK/);
        assert.equal(input.some(item => ["custom_tool_call", "custom_tool_call_output"].includes(item.type)), false);
        native(res, [reply("CHECKPOINT_HANDOFF: The command printed CHECKPOINT_TOOL_MARKER.")]);
      } else {
        normal++;
        if (normal === 1) native(res, [{
          type: "custom_tool_call", id: "ctc_synthetic", call_id: "call_checkpoint", namespace: "functions", name: "exec",
          input: 'text("CHECKPOINT_TOOL_MARKER");',
        }], 40_000);
        else {
          assert.ok(input.some(item => item.type === "compaction" && item.encrypted_content === "synthetic-native-checkpoint"));
          native(res, [reply(normal === 2 ? "COMPACTION_DONE" : "SOURCE_RESUME_DONE")]);
        }
      }
    } catch (error) {
      failures.push(error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Synthetic upstream assertion failed" } }));
    }
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => stop(upstream));
  const config: BridgeConfig = {
    compaction_cache_dir: join(scratch, "cache"),
    upstreams: { fake: { base_url: upstreamUrl } },
    models: {
      source: { catalog: "gpt-6.1-sol", upstream: "fake", model: "source-deployment", context_window: 272_000 },
      target: { catalog: "deepseek-flash", upstream: "fake", model: "target-deployment", context_window: 272_000 },
    },
  };
  const bridge = createBridgeServer(config);
  bridge.on("request", req => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST") clientRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
    });
  });
  const bridgeUrl = await listen(bridge);
  t.after(() => stop(bridge));
  const catalog = buildCatalog(config);
  for (const model of catalog.models) model.auto_compact_token_limit = 30_000;
  const catalogPath = join(home, "models.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  await writeFile(join(home, "config.toml"), `
model_provider = "bridge"
model = "source"
model_catalog_json = ${JSON.stringify(catalogPath)}
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
  delete env.CODEX_API_KEY;
  let invocations = 0;
  const invoke = async (prompt: string, model?: string) => {
    const args = invocations++ === 0
      ? ["exec", "--skip-git-repo-check", "-C", work, "--json", "-s", "workspace-write", "--", prompt]
      : ["exec", "resume", "--last", "--skip-git-repo-check", "--json", "-m", model ?? "source", prompt];
    try {
      const pending = run(binary!, args, { cwd: work, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      pending.child.stdin?.end();
      const result = await pending;
      await writeFile(join(scratch, `invoke-${invocations}.stdout`), result.stdout);
      assert.deepEqual(failures, []);
      return result.stdout;
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      await writeFile(join(scratch, `invoke-${invocations}.failure`), `${output.stdout ?? ""}\n${output.stderr ?? ""}`);
      assert.deepEqual(failures, []);
      throw error;
    }
  };
  t.after(() => writeFile(join(scratch, "requests.json"), JSON.stringify({ clientRequests, upstreamRequests }, null, 2)));
  return { upstreamRequests, clientRequests, invoke };
}

test("real codeks: native compaction, retained history, resume and model switch", { skip: !binary, timeout: 180_000 }, async t => {
  const f = await fixture(t);
  const exports = () => f.upstreamRequests.filter(({ body }) => body.input?.at(-1)?.content?.[0]?.text === HANDOFF_PROMPT);
  assert.match(await f.invoke(original), /COMPACTION_DONE/);
  assert.equal(exports().length, 0);
  const resumedWire = f.clientRequests.at(-1);
  const checkpoint = resumedWire.input.find((item: any) => item.type === "compaction");
  assert.ok(checkpoint);
  const carrier = decodeCompaction(checkpoint.encrypted_content)!;
  assert.equal(carrier.summary, undefined);
  assert.match(JSON.stringify(resumedWire.input), /RETAINED_USER_TASK/);
  assert.equal(resumedWire.input.some((item: any) => item.type === "custom_tool_call_output"), false);
  assert.match(await f.invoke(later), /SOURCE_RESUME_DONE/);
  assert.equal(exports().length, 0);
  assert.match(await f.invoke(switched, "target"), /TARGET_DONE/);
  assert.equal(exports().length, 1);
  const firstNativeContinuation = f.upstreamRequests.find(({ body }) =>
    body.input?.at(-1)?.type === "compaction");
  assert.ok(firstNativeContinuation);
  assert.deepEqual(exports()[0].body.input.slice(0, -1), firstNativeContinuation.body.input,
    "Deferred handoff reuses the actual original continuation prefix, including client-reinserted context");
  assert.equal(f.clientRequests.filter(body => body.input.at(-1)?.type === "compaction_trigger").length, 1);
  const last = f.clientRequests.at(-1);
  assert.equal(last.model, "target");
  const stored = decodeCompaction(last.input.find((item: any) => item.type === "compaction").encrypted_content)!;
  assert.equal(stored.summary, undefined, "Deferred materialization must not rewrite the client's stored checkpoint");
});
