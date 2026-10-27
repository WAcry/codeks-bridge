import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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

interface Scenario {
  name: string;
  status?: number;
  error: Record<string, unknown>;
  message: RegExp;
  requests?: number;
  errorInfo?: string;
}

const scenarios: Scenario[] = [
  {
    name: "HTTP model not found stops without retrying",
    status: 404,
    error: { type: "invalid_request_error", code: "model_not_found", message: "Synthetic unavailable model" },
    message: /Synthetic unavailable model/, errorInfo: "model_not_found",
  },
  {
    name: "SSE model not found stops without retrying",
    error: { type: "invalid_request_error", code: "model_not_found", message: "Synthetic unavailable model" },
    message: /Synthetic unavailable model/, errorInfo: "model_not_found",
  },
  {
    name: "structured SSE policy failure stops without retrying",
    error: {
      type: "invalid_request_error", code: "misalignment_policy_violation", message: "Synthetic policy block",
      misalignment: {
        error_type: "synthetic_classification", detailed_explanation: "Synthetic explanation",
        steer: { message: "Synthetic steering" }, review_target: "synthetic-review-target",
      },
    },
    message: /Synthetic policy block/, errorInfo: "misalignment_policy_violation",
  },
  {
    name: "HTTP spend limit uses the quota message without retrying",
    status: 429,
    error: { type: "insufficient_quota", code: "organization_spend_limit_exceeded", message: "Synthetic organization spend limit" },
    message: /Quota exceeded\. Check your plan and billing details\./, errorInfo: "usage_limit_exceeded",
  },
  {
    name: "SSE spend limit uses the quota message without retrying",
    error: { code: "project_spend_limit_exceeded", message: "Synthetic project spend limit" },
    message: /Quota exceeded\. Check your plan and billing details\./, errorInfo: "usage_limit_exceeded",
  },
  {
    name: "SSE usage not included uses the plan message without retrying",
    error: { code: "usage_not_included", message: "Synthetic usage restriction" },
    message: /upgrade to Plus/, errorInfo: "usage_limit_exceeded",
  },
  {
    name: "SSE flex unavailable uses the capacity message without retrying",
    error: { code: "flex_unavailable", message: "Synthetic flex restriction" },
    message: /Flex capacity unavailable\./, errorInfo: "flex_unavailable",
  },
  {
    name: "HTTP usage limit retains plan and reset information",
    status: 429,
    error: {
      type: "usage_limit_reached", code: "usage_limit_reached", message: "Synthetic usage limit",
      plan_type: "plus", resets_at: 4_102_444_800,
    },
    message: /Upgrade to Pro[\s\S]*try again at/, errorInfo: "usage_limit_exceeded",
  },
  {
    name: "HTTP bad request keeps an unknown code out of the stream retry path",
    status: 400,
    error: { type: "invalid_request_error", code: "invalid_encrypted_content", message: "Synthetic encrypted content rejection" },
    message: /invalid_encrypted_content[\s\S]*Synthetic encrypted content rejection/,
  },
  {
    name: "unknown SSE code is retried by the client, not the bridge",
    error: { code: "synthetic_unknown_error", message: "Synthetic unknown stream failure" },
    message: /Synthetic unknown stream failure/, requests: 2,
  },
];

for (const scenario of scenarios) {
  test(`real codeks: ${scenario.name}`, { skip: !binary, timeout: 120_000 }, async (t) => {
    let upstreamRequests = 0;
    let clientRequests = 0;
    const failures: unknown[] = [];
    const upstream = createServer(async (req, res) => {
      try {
        assert.equal(req.url, "/v1/responses");
        for await (const _chunk of req) { /* Drain the request before replying. */ }
        upstreamRequests++;
        if (scenario.status !== undefined) {
          res.writeHead(scenario.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: scenario.error }));
        } else {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(formatSse({ type: "response.failed", response: { id: "resp_synthetic_failure", status: "failed", error: scenario.error } }));
        }
      } catch (error) {
        failures.push(error);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Synthetic error fixture failed" } }));
      }
    });
    const upstreamPort = await listen(upstream);
    t.after(() => stop(upstream));
    const config: BridgeConfig = {
      upstreams: { test: { base_url: `http://127.0.0.1:${upstreamPort}/v1` } },
      models: { "error-probe": { catalog: "gpt-6.1-sol", upstream: "test", model: "synthetic-deployment" } },
    };
    const bridge = createBridgeServer(config);
    bridge.on("request", (req) => { if (req.method === "POST") clientRequests++; });
    config.port = await listen(bridge);
    t.after(() => stop(bridge));
    const scratch = await mkdtemp(join(tmpdir(), "codeks-errors-e2e-"));
    t.diagnostic(`Scratch directory: ${scratch}`);
    const home = join(scratch, "home");
    const work = join(scratch, "work");
    await mkdir(home); await mkdir(work);
    await writeFile(join(home, "config.toml"), [
      "check_for_update_on_startup = false",
      configSnippet(config).replace("[model_providers.bridge.capabilities]", "request_max_retries = 0\nstream_max_retries = 1\n[model_providers.bridge.capabilities]"),
    ].join("\n"));
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    let stdout = "";
    let exitCode: unknown;
    try {
      const pending = run(binary!, ["exec", "--skip-git-repo-check", "--json", "-C", work, "--", "Return a short greeting."], {
        cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
      });
      pending.child.stdin?.end();
      ({ stdout } = await pending);
    } catch (cause) {
      const error = cause as { code?: unknown; stdout?: string; stderr?: string };
      exitCode = error.code;
      stdout = error.stdout ?? "";
      await writeFile(join(scratch, "failure.txt"), `${stdout}\n${error.stderr ?? ""}`);
    }
    assert.deepEqual(failures, []);
    assert.equal(exitCode, 1, "The failed model request must end the client turn");
    assert.equal(clientRequests, scenario.requests ?? 1, "Only the client decides whether to retry");
    assert.equal(upstreamRequests, clientRequests, "Each client request makes exactly one upstream attempt");
    const events = stdout.trim().split("\n").map(line => JSON.parse(line));
    const failed = events.find(event => event.type === "turn.failed");
    assert.ok(failed, stdout);
    assert.match(failed.error.message, scenario.message);

    if (scenario.errorInfo) {
      const sessions = join(home, "sessions");
      const paths = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith(".jsonl"));
      const records = (await Promise.all(paths.map(path => readFile(join(sessions, path), "utf8"))))
        .flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
      assert.ok(records.some(record => record.type === "event_msg" &&
        (record.payload.type === "error" ? record.payload : record.payload.error)?.codex_error_info === scenario.errorInfo),
        "The real client must retain the specific error classification");
      // Codex intentionally excludes sensitive misalignment details from rollout storage.
      if (scenario.error.misalignment) assert.ok(!JSON.stringify(records).includes("Synthetic explanation"));
    }
  });
}
