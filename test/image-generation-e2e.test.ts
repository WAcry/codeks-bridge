import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { buildCatalog, configSnippet } from "../src/catalog.ts";
import { createBridgeServer } from "../src/server.ts";
import { formatSse } from "../src/sse.ts";
import type { BridgeConfig } from "../src/types.ts";

const run = promisify(execFile);
const binary = process.env.CODEKS_BIN;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const editedPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==";
type Adapter = "claude" | "deepseek";

function token(claims: Record<string, unknown>): string {
  return `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

async function login(home: string, account: string): Promise<string> {
  const access = token({ sub: account, exp: Date.now() / 1000 + 7200 });
  await writeFile(join(home, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
    tokens: {
      access_token: access, refresh_token: "synthetic-refresh", account_id: account,
      id_token: token({ "https://api.openai.com/auth": {
        chatgpt_user_id: "synthetic-user", chatgpt_account_id: account, chatgpt_plan_type: "plus",
      } }),
    },
  }), { mode: 0o600 });
  return access;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

function completion(adapter: Adapter, call?: { id: string; name: string; code: string }): Response {
  if (adapter === "deepseek") {
    const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: {
      name: call.name, arguments: JSON.stringify({ input: call.code }),
    } }] } : { content: "IMAGE_TASK_DONE" };
    const chunks = [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 12 } },
    ];
    return new Response(chunks.map(chunk => formatSse(chunk)).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }
  const block = call
    ? { type: "tool_use", id: call.id, name: call.name, input: { input: call.code } }
    : { type: "text", text: "IMAGE_TASK_DONE" };
  const events = [
    { type: "message_start", message: {
      id: "msg_synthetic_image", type: "message", role: "assistant", content: [],
      usage: { input_tokens: 100, output_tokens: 0 },
    } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 12 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => formatSse(event, event.type)).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function scenario(t: TestContext, adapter: Adapter, denied = false): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "codeks-image-e2e-"));
  t.diagnostic(`Scratch directory: ${scratch}`);
  const home = join(scratch, "home");
  const work = join(scratch, "work");
  const subscription = join(scratch, "subscription");
  await Promise.all([mkdir(home), mkdir(work), mkdir(subscription)]);
  // A client login enables the native tool; the bridge uses its own selected subscription.
  const localToken = await login(home, "synthetic-client-account");
  const upstreamToken = await login(subscription, "synthetic-image-account");
  const config: BridgeConfig = {
    image_generation: { upstream: "subscription" },
    upstreams: {
      inference: { base_url: "https://inference.example/v1" },
      subscription: { base_url: "https://subscription.example/backend-api/codex", auth: { type: "chatgpt", codex_home: subscription } },
    },
    models: { work: {
      catalog: adapter === "claude" ? "claude-sonnet-5-5" : "deepseek-flash",
      upstream: "inference", model: "synthetic-working-model",
    } },
  };
  const failures: unknown[] = [];
  const modelRequests: any[] = [];
  const imageRequests: { path: string; body: any }[] = [];
  const savedPaths: string[] = [];
  let execName = "";
  const bridge = createBridgeServer(config, { fetch: async (url, init) => {
    try {
      const body = JSON.parse(String(init?.body));
      const path = new URL(String(url)).pathname;
      if (path.startsWith("/backend-api/codex/images/")) {
        assert.equal(new URL(String(url)).origin, "https://subscription.example");
        imageRequests.push({ path, body });
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), `Bearer ${upstreamToken}`);
        assert.notEqual(headers.get("authorization"), `Bearer ${localToken}`);
        assert.equal(headers.get("chatgpt-account-id"), "synthetic-image-account");
        assert.ok(headers.get("x-codex-image-turn-id"));
        assert.equal(headers.get("anthropic-version"), null);
        assert.equal(body.model, "gpt-image-2");
        assert.equal(body.quality, "auto");
        assert.equal(body.size, "auto");
        if (denied) return Response.json({ error: {
          type: "invalid_request_error", code: "synthetic_image_denied", message: "SYNTHETIC_IMAGE_DENIED",
        } }, { status: 400, headers: { "x-codex-imagegen-request-id": "synthetic-denied-request" } });
        assert.equal(path, imageRequests.length === 1 ? "/backend-api/codex/images/generations" : "/backend-api/codex/images/edits");
        assert.equal(body.background, imageRequests.length === 1 ? "opaque" : "transparent");
        assert.equal(body.prompt, imageRequests.length === 1 ? "SYNTHETIC_GENERATE" : "SYNTHETIC_EDIT");
        if (imageRequests.length === 2) {
          assert.equal(body.images.length, 1);
          assert.match(body.images[0].image_url, /^data:image\/png;base64,/);
          assert.deepEqual(Buffer.from(body.images[0].image_url.split(",")[1], "base64"), Buffer.from(png, "base64"));
        }
        return Response.json({
          created: 1, background: body.background,
          data: [{ b64_json: imageRequests.length === 1 ? png : editedPng, generation_id: `synthetic-generation-${imageRequests.length}` }],
        }, { headers: { "x-codex-imagegen-request-id": `synthetic-image-request-${imageRequests.length}` } });
      }
      assert.equal(String(url), adapter === "claude" ? "https://inference.example/v1/messages" : "https://inference.example/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), null, "The local login must not become inference credentials");
      modelRequests.push(body);
      assert.equal(body.model, "synthetic-working-model");
      if (modelRequests.length === 1) {
        assert.match(JSON.stringify(body), /image_gen__imagegen/, "The generated configuration must expose the native image tool in Code Mode");
        const names = body.tools.map((tool: any) => tool.name ?? tool.function?.name);
        execName = names.find((name: string) => name === "exec" || name.endsWith("__exec"));
        assert.ok(execName);
        return completion(adapter, { id: "synthetic_generate_exec", name: execName,
          code: 'generatedImage(await tools.image_gen__imagegen({prompt:"SYNTHETIC_GENERATE",transparent_background:false}));' });
      }
      if (denied) {
        assert.equal(modelRequests.length, 2);
        assert.match(JSON.stringify(body.messages), /SYNTHETIC_IMAGE_DENIED/);
        assert.doesNotMatch(JSON.stringify(body.messages), /data:image\/png;base64,/);
        return completion(adapter);
      }
      assert.ok(modelRequests.length <= 3);
      const resultId = modelRequests.length === 2 ? "synthetic_generate_exec" : "synthetic_edit_exec";
      const expectedImage = modelRequests.length === 2 ? png : editedPng;
      if (adapter === "claude") {
        const result = body.messages.flatMap((item: any) => item.content)
          .find((block: any) => block.type === "tool_result" && block.tool_use_id === resultId);
        assert.ok(result);
        const image = result.content.find((block: any) => block.type === "image");
        assert.equal(image?.source.type, "base64");
        assert.equal(image?.source.data, expectedImage);
      } else {
        assert.ok(body.messages.some((item: any) => item.role === "tool" && item.tool_call_id === resultId));
        assert.ok(body.messages.some((item: any) => item.role === "user" && Array.isArray(item.content) &&
          item.content.some((part: any) => part.type === "image_url" && part.image_url.url === `data:image/png;base64,${expectedImage}`)));
      }
      const files = (await readdir(join(home, "generated_images"), { recursive: true })).filter(path => path.endsWith(".png"));
      assert.equal(files.length, modelRequests.length - 1, "The client saves each generated image before continuing inference");
      const savedImages = await Promise.all(files.map(async file => (await readFile(join(home, "generated_images", file))).toString("base64")));
      assert.deepEqual(savedImages.sort(), (modelRequests.length === 2 ? [png] : [png, editedPng]).sort());
      savedPaths.splice(0, savedPaths.length, ...files.map(file => join(home, "generated_images", file)));
      if (modelRequests.length === 2) return completion(adapter, { id: "synthetic_edit_exec", name: execName,
        code: `generatedImage(await tools.image_gen__imagegen(${JSON.stringify({
          prompt: "SYNTHETIC_EDIT", transparent_background: true, referenced_image_paths: [savedPaths[0]],
        })}));` });
      return completion(adapter);
    } catch (error) {
      failures.push(error);
      return Response.json({ error: { message: "Synthetic image fixture failed" } }, { status: 500 });
    }
  } });
  config.port = await listen(bridge);
  t.after(async () => { bridge.closeAllConnections(); await new Promise<void>(resolve => bridge.close(() => resolve())); });
  const catalogPath = adapter === "claude" && !denied ? join(home, "catalog.json") : undefined;
  if (catalogPath) await writeFile(catalogPath, JSON.stringify(buildCatalog(config)));
  await writeFile(join(home, "config.toml"), [
    "check_for_update_on_startup = false",
    `chatgpt_base_url = "http://127.0.0.1:${config.port}"`,
    configSnippet(config, catalogPath).replace("[model_providers.bridge.capabilities]",
      "request_max_retries = 0\nstream_max_retries = 0\n[model_providers.bridge.capabilities]"),
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  try {
    const pending = run(binary!, ["exec", "--skip-git-repo-check", "--json", "-C", work, "--",
      "SYNTHETIC_IMAGE_TASK: generate an image and edit it using the image generation tool."], {
      cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    await writeFile(join(scratch, "exec.stdout"), stdout);
    assert.deepEqual(failures, []);
    assert.match(stdout, /IMAGE_TASK_DONE/);
    assert.ok(stdout.split("\n").some(line => line && JSON.parse(line).type === "turn.completed"), stdout);
    assert.equal(modelRequests.length, denied ? 2 : 3);
    assert.equal(imageRequests.length, denied ? 1 : 2);
    assert.equal(savedPaths.length, denied ? 0 : 2);
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    await writeFile(join(scratch, "failure.txt"), `${output.stdout ?? ""}\n${output.stderr ?? ""}`);
    assert.deepEqual(failures, []);
    throw error;
  }
}

for (const adapter of ["claude", "deepseek"] as const) {
  test(`real codeks: ${adapter} Code Mode generates, saves and edits subscription images`, {
    skip: !binary, timeout: 120_000,
  }, t => scenario(t, adapter));
}

test("real codeks: image HTTP failure reaches Claude as a tool error without a bridge retry", {
  skip: !binary, timeout: 120_000,
}, t => scenario(t, "claude", true));
