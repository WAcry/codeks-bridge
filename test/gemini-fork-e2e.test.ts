import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
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

async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function reply(res: ServerResponse, parts: Record<string, unknown>[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const part of parts) {
    res.write(formatSse({ candidates: [{ index: 0, content: { role: "model", parts: [part] } }] }));
  }
  res.end(formatSse({
    candidates: [{ index: 0, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 120 },
  }));
}

test("real codeks: Gemini full-history forks preserve signed calls across synthetic aborted results", {
  skip: !binary, timeout: 120_000,
}, async t => {
  const failures: unknown[] = [];
  const requests: any[] = [];
  const clientRequests: any[] = [];
  const childTask = "GEMINI_FORK_CHILD_TASK: return only GEMINI_FORK_CHILD_DONE.";
  const spawnId = "synthetic-fork-spawn";
  const execId = "synthetic-fork-exec";
  let originalParts: any[] = [];
  let parentSteps = 0;
  let childRequests = 0;
  const userTexts = (body: any): string => body.contents
    .filter((content: any) => content.role === "user")
    .flatMap((content: any) => content.parts.map((part: any) => part.text ?? "")).join("\n");
  const declaration = (body: any, name: string): string => {
    const tool = body.tools.flatMap((group: any) => group.functionDeclarations ?? [])
      .find((entry: any) => entry.name === name || entry.name.endsWith(`__${name}`));
    assert.ok(tool, `The client must expose ${name}`);
    return tool.name;
  };
  const upstream = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1beta/models/synthetic-gemini:streamGenerateContent?alt=sse");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const child = userTexts(body).includes(childTask);
      if (!originalParts.length) {
        assert.equal(child, false);
        parentSteps++;
        originalParts = [{
          functionCall: {
            name: declaration(body, "spawn_agent"), id: spawnId,
            args: { task_name: "synthetic_fork_child", message: childTask, fork_turns: "all" },
          },
          thoughtSignature: "synthetic-fork-signature",
        }, {
          functionCall: {
            name: declaration(body, "exec"), id: execId,
            args: { input: 'text("GEMINI_FORK_EXEC_DONE");' },
          },
        }];
        reply(res, originalParts);
        return;
      }

      const allParts = body.contents.flatMap((content: any) => content.parts);
      const calls = allParts.filter((part: any) => part.functionCall);
      const ids = calls.map((part: any) => part.functionCall.id);
      assert.equal(new Set(ids).size, ids.length, "Native replay must not duplicate a visible tool call");
      const spawnContent = body.contents.find((content: any) => content.parts.some((part: any) => part.functionCall?.id === spawnId));
      assert.ok(spawnContent, "The fork must retain the spawn call it inherited");
      assert.equal(spawnContent.role, "model");
      assert.deepEqual(spawnContent.parts.find((part: any) => part.functionCall?.id === spawnId), originalParts[0],
        "The first call retains its native signature instead of an imported-history marker");
      const inheritedExec = calls.find((part: any) => part.functionCall.id === execId);
      if (inheritedExec) {
        assert.deepEqual(inheritedExec, originalParts[1]);
        assert.deepEqual(spawnContent.parts, originalParts,
          "Calls from the same generation must precede all their results in one model Content");
      }
      const results = allParts.filter((part: any) => part.functionResponse).map((part: any) => part.functionResponse);
      const spawnResult = results.find((result: any) => result.id === spawnId);
      assert.ok(spawnResult);
      assert.equal(spawnResult.name, originalParts[0].functionCall.name);
      if (child) {
        childRequests++;
        assert.equal(spawnResult.response.output, "aborted",
          "Codex repairs the still-running parent spawn call in the child's full-history snapshot");
        const inheritedRequest = clientRequests.find(request => request.input.some((item: any) =>
          (item.type === "agent_message" || item.role === "user") && JSON.stringify(item.content).includes(childTask)));
        assert.ok(inheritedRequest);
        assert.equal(Boolean(inheritedExec), inheritedRequest.input.some((item: any) =>
          ["function_call", "custom_tool_call"].includes(item.type) && item.call_id === execId),
        "The bridge must replay exactly the calls present in the child's snapshot");
        // The fork can start before the sibling call is durable. Only the
        // inherited portion is required; the bridge must not invent the rest.
        reply(res, [{ text: "GEMINI_FORK_CHILD_DONE" }]);
        return;
      }

      parentSteps++;
      assert.ok(parentSteps <= 4, "The parent only needs tool completion and one child wait");
      assert.ok(inheritedExec, "The parent retains both completed calls");
      assert.notEqual(spawnResult.response.output, "aborted");
      const execResult = results.find((result: any) => result.id === execId);
      assert.ok(execResult);
      assert.match(execResult.response.output, /GEMINI_FORK_EXEC_DONE/);
      if (userTexts(body).includes("GEMINI_FORK_CHILD_DONE")) {
        reply(res, [{ text: "GEMINI_FORK_PARENT_DONE" }]);
      } else {
        reply(res, [{ functionCall: {
          name: declaration(body, "wait_agent"), id: `synthetic-fork-wait-${parentSteps}`,
          args: { timeout_ms: 10_000 },
        }, thoughtSignature: "synthetic-wait-signature" }]);
      }
    } catch (error) {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Synthetic Gemini fork fixture failed" } }));
    }
  });
  const upstreamPort = await listen(upstream);
  t.after(() => stop(upstream));
  const config: BridgeConfig = {
    upstreams: { fixture: { base_url: `http://127.0.0.1:${upstreamPort}/v1beta` } },
    models: { gemini: { upstream: "fixture", model: "synthetic-gemini", catalog: "gemini-3.8-flash" } },
  };
  const bridge = createBridgeServer(config, {
    transformRequest(request) { clientRequests.push(structuredClone(request)); },
  });
  config.port = await listen(bridge);
  t.after(() => stop(bridge));
  const scratch = await mkdtemp(join(tmpdir(), "codeks-gemini-fork-e2e-"));
  t.diagnostic(`Scratch directory: ${scratch}`);
  const home = join(scratch, "home");
  const work = join(scratch, "work");
  await Promise.all([mkdir(home), mkdir(work)]);
  await writeFile(join(home, "config.toml"), [
    "check_for_update_on_startup = false",
    configSnippet(config).replace("[model_providers.bridge.capabilities]",
      "request_max_retries = 0\nstream_max_retries = 0\n[model_providers.bridge.capabilities]"),
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  try {
    const pending = run(binary!, [
      "exec", "--skip-git-repo-check", "--json", "-C", work, "--",
      "GEMINI_FORK_ROOT_TASK: spawn one child with full history, run the Code Mode tool, and wait for the child.",
    ], { cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    await writeFile(join(scratch, "exec.stdout"), stdout);
    assert.deepEqual(failures, []);
    assert.match(stdout, /GEMINI_FORK_PARENT_DONE/);
    assert.ok(stdout.split("\n").some(line => line && JSON.parse(line).type === "turn.completed"));
    assert.equal(childRequests, 1, "The inherited child request must succeed without a retry");
    assert.equal(clientRequests.length, requests.length, "Every client request must reach the native upstream");
    assert.ok(clientRequests.some(request => request.input.some((item: any) =>
      item.type === "function_call_output" && item.call_id === spawnId && item.output === "aborted")),
    "The fixture must exercise Codex's synthetic aborted result, not a hand-built history");
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    await writeFile(join(scratch, "failure.txt"), `${output.stdout ?? ""}\n${output.stderr ?? ""}`);
    assert.deepEqual(failures, []);
    throw error;
  } finally {
    await writeFile(join(scratch, "requests.json"), JSON.stringify({ clientRequests, requests }, null, 2));
  }
});
