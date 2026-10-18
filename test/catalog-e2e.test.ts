import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildCatalog, configSnippet } from "../src/catalog.ts";
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

async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test("real codeks: HTTP catalog preserves Code Mode and discovers deferred MCP tools through ALL_TOOLS", {
  skip: !binary, timeout: 120_000,
}, async (t) => {
  const failures: unknown[] = [];
  const upstreamRequests: any[] = [];
  const mcpCalls: any[] = [];
  const catalogRequests: { url: string; authorization?: string }[] = [];
  const clientRequests: any[] = [];
  const mcp = createServer(async (req, res) => {
    try {
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      if (request.id === undefined) { res.writeHead(202); res.end(); return; }
      let result: any;
      switch (request.method) {
        case "initialize": result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} }, serverInfo: { name: "catalog-probe", version: "1.0.0" },
        }; break;
        case "tools/list": result = { tools: [{
          name: "lookup", description: "CATALOG_MCP_PROBE: return the requested test value.",
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        }] }; break;
        case "tools/call":
          mcpCalls.push(request.params);
          assert.equal(request.params.name, "lookup");
          result = { content: [{ type: "text", text: `MCP_CONFIRMED:${request.params.arguments.value}` }] };
          break;
        default: throw new Error(`Unexpected MCP method: ${request.method}`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    } catch (error) {
      failures.push(error);
      res.writeHead(500); res.end();
    }
  });
  const mcpPort = await listen(mcp);
  t.after(() => stop(mcp));
  const upstream = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      upstreamRequests.push(body);
      assert.equal(body.model, "deployment-alias");
      const exec = body.tools.find((tool: any) => tool.function.name === "exec" || tool.function.name.endsWith("__exec"));
      assert.ok(exec, "The reviewed catalog enables Code Mode without feature overrides");
      assert.match(exec.function.description, /ALL_TOOLS/);
      assert.doesNotMatch(exec.function.description, /CATALOG_MCP_PROBE/, "Deferred MCP definitions must not become eager exec instructions");
      assert.equal(body.tools.some((tool: any) => /lookup|tool_search/.test(tool.function.name)), false);
      const first = upstreamRequests.length === 1;
      if (!first) assert.ok(JSON.stringify(body.messages).includes("MCP_CONFIRMED:remote-catalog-mcp-ok"), "The deferred MCP result must reach the upstream");
      const delta = first ? { tool_calls: [{
        index: 0, id: "call_catalog_discovery", type: "function", function: {
          name: exec.function.name,
          arguments: JSON.stringify({ input: [
            'const tool = ALL_TOOLS.find(item => item.description.includes("CATALOG_MCP_PROBE"));',
            'if (!tool) throw new Error("Deferred MCP tool was not discovered");',
            'text({ discovered: tool.name });',
            'text(await tools[tool.name]({ value: "remote-catalog-mcp-ok" }));',
          ].join("\n") }),
        },
      }] } : { content: "REMOTE_CATALOG_DONE" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(formatSse({ choices: [{ index: 0, delta, finish_reason: null }] }));
      res.write(formatSse({ choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] }));
      res.write(formatSse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 12 } }));
      res.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Synthetic catalog assertion failed" } }));
    }
  });
  const upstreamPort = await listen(upstream);
  t.after(() => stop(upstream));
  const config: BridgeConfig = {
    upstreams: { test: { base_url: `http://127.0.0.1:${upstreamPort}/v1` } },
    models: {
      "work-small": { catalog: "deepseek-flash", upstream: "test", model: "deployment-alias", context_window: 128_000 },
      "work-large": { catalog: "deepseek-flash", upstream: "test", model: "deployment-alias", context_window: 256_000 },
    },
  };
  const bridge = createBridgeServer(config);
  bridge.on("request", (req) => {
    if (req.method === "GET") {
      catalogRequests.push({ url: req.url!, authorization: req.headers.authorization });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        clientRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
        assert.equal(req.headers["x-openai-internal-codex-responses-lite"], "true");
      } catch (error) { failures.push(error); }
    });
  });
  config.port = await listen(bridge);
  t.after(() => stop(bridge));
  const scratch = await mkdtemp(join(tmpdir(), "codeks-catalog-e2e-"));
  t.diagnostic(`Scratch directory: ${scratch}`);
  const home = join(scratch, "home");
  const work = join(scratch, "work");
  await mkdir(home); await mkdir(work);
  await writeFile(join(home, "config.toml"), [
    "check_for_update_on_startup = false", configSnippet(config).replace("[model_providers.bridge.capabilities]", "request_max_retries = 0\nstream_max_retries = 0\n[model_providers.bridge.capabilities]"),
    "[mcp_servers.catalog_probe]", `url = "http://127.0.0.1:${mcpPort}/mcp"`,
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  const invoke = async (args: string[]) => {
    try {
      const pending = run(binary!, args, { cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
      pending.child.stdin?.end();
      return await pending;
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      await writeFile(join(scratch, "failure.txt"), `${output.stdout ?? ""}\n${output.stderr ?? ""}`);
      assert.deepEqual(failures, []);
      throw error;
    }
  };
  const discovered = JSON.parse((await invoke(["debug", "models"])).stdout);
  const expected = buildCatalog(config);
  // Codex omits null optional fields and adds serde defaults when it serializes ModelInfo again.
  for (const [index, model] of discovered.models.entries()) {
    for (const key of ["slug", "context_window", "max_context_window", "tool_mode", "use_responses_lite", "supports_search_tool", "default_reasoning_level", "supported_reasoning_levels"]) {
      assert.deepEqual(model[key], expected.models[index][key], `Catalog field ${key} survives client decoding`);
    }
    assert.ok(model.model_messages.instructions_template === expected.models[index].model_messages.instructions_template, "The reviewed prompt survives client decoding");
  }
  assert.deepEqual(discovered.models.map((model: any) => model.slug), ["work-small", "work-large"]);
  assert.ok(discovered.models.every((model: any) => model.supports_search_tool && model.tool_mode === "code_mode_only"));
  assert.equal(catalogRequests.length, 1);
  assert.match(catalogRequests[0].url, /^\/v1\/models\?client_version=/);
  assert.equal(catalogRequests[0].authorization, "Bearer codeks-bridge-local");
  await invoke(["debug", "models"]);
  assert.equal(catalogRequests.length, 1, "A repeated catalog command reuses the provider cache");
  const cache = JSON.parse(await readFile(join(home, "models_cache.json"), "utf8"));
  assert.ok(cache.etag, "The server provides an ETag for subsequent response-driven refreshes");
  const { stdout } = await invoke(["exec", "--skip-git-repo-check", "--json", "-C", work, "--", "Find the available catalog test MCP tool and call it through Code Mode."]);
  assert.match(stdout, /REMOTE_CATALOG_DONE/);
  assert.deepEqual(failures, []);
  assert.ok(catalogRequests.length <= 2, "Turn startup may refresh once; an unchanged response ETag must not refetch for each tool step");
  assert.equal(upstreamRequests.length, 2);
  assert.deepEqual(mcpCalls.map(({ name, arguments: args }) => ({ name, arguments: args })), [{ name: "lookup", arguments: { value: "remote-catalog-mcp-ok" } }]);
  assert.ok(clientRequests.every(body => body.tools === undefined && body.input.some((item: any) => item.type === "additional_tools")));
});
