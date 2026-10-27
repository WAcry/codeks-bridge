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

for (const scenario of [
  { summary: "auto", failure: false },
  { summary: "none", failure: false },
  { summary: "auto", failure: true },
] as const) {
  const { summary, failure } = scenario;
  test(`real codeks: Gemini Code Mode aliases and signed parts survive ${failure ? "interruption and " : ""}resume with ${summary} summary`, {
    skip: !binary, timeout: 120_000,
  }, async t => {
    const visible = summary === "auto";
    const failures: unknown[] = [];
    const requests: any[] = [];
    const clientRequests: any[] = [];
    const interruptedPart = { text: "GEMINI_INTERRUPTED_PLAN", thought: true, thoughtSignature: "synthetic-interrupted-signature" };
    const continuation = { role: "user", parts: [{ text: "Continue." }] };
    const call = {
      functionCall: { name: "exec", id: "synthetic-call", args: { input: 'text("GEMINI_TOOL_EXECUTED");' } },
      thoughtSignature: "synthetic-call-signature",
    };
    const firstParts = [
      ...(visible ? [{ text: "GEMINI_TOOL_PLAN", thought: true }] : []),
      { text: "GEMINI_BEFORE_TOOL" }, call,
    ];
    const finalParts = [
      ...(visible ? [{ text: "GEMINI_FINAL_PLAN", thought: true }] : []),
      { text: "GEMINI_DONE" }, { text: "", thoughtSignature: "synthetic-final-signature" },
    ];
    const upstream = createServer(async (req, res) => {
      try {
        assert.equal(req.url, "/v1beta/models/synthetic-gemini:streamGenerateContent?alt=sse");
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "MEDIUM");
        assert.equal(body.generationConfig.thinkingConfig.includeThoughts, visible);
        const declarations = body.tools.flatMap((tool: any) => tool.functionDeclarations ?? []);
        const exec = declarations.find((tool: any) => tool.name === "functions__exec");
        assert.ok(exec, "The reviewed Gemini catalog enables Code Mode");
        assert.match(exec.description, /ALL_TOOLS/);
        assert.equal(new Set(declarations.map((tool: any) => tool.name)).size, declarations.length);

        if (failure && requests.length === 1) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(formatSse({ candidates: [{ index: 0, content: { role: "model", parts: [interruptedPart] } }] }));
          // Beginning text finishes the previous thought segment. EOF leaves
          // this new text unfinished, so only the thought is durable history.
          res.end(formatSse({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "GEMINI_PARTIAL_NOT_PERSISTED" }] } }] }));
          return;
        }
        const step = requests.length - (failure ? 1 : 0);
        if (failure) {
          const prefix = [...requests[0].contents, { role: "model", parts: [interruptedPart] }, continuation];
          assert.deepEqual(body.contents.slice(0, prefix.length), prefix,
            "The retry and all later requests must retain the exact continuation boundary before newly signed output");
          assert.equal(body.contents.flatMap((content: any) => content.parts).filter((part: any) => part.text === "Continue.").length, 1);
          assert.doesNotMatch(JSON.stringify(body.contents), /GEMINI_PARTIAL_NOT_PERSISTED/);
          if (step === 1) assert.deepEqual(body.contents.slice(-2), prefix.slice(-2), "Retry ends at a valid user continuation boundary");
        }
        if (step > 1) {
          const index = body.contents.findIndex((content: any) => content.parts?.some((part: any) => part.functionCall?.id === "synthetic-call"));
          assert.ok(index >= 0, "The signed original function call must be replayed");
          assert.equal(body.contents[index].role, "model");
          assert.deepEqual(body.contents[index].parts, firstParts, "Signed parts and the original alias stay at their original positions");
          const result = body.contents[index + 1];
          assert.equal(result.role, "user");
          const responses = result.parts.filter((part: any) => part.functionResponse).map((part: any) => part.functionResponse);
          assert.equal(responses.length, 1);
          assert.equal(responses[0].id, "synthetic-call");
          assert.equal(responses[0].name, "exec");
          assert.match(JSON.stringify(responses[0].response), /GEMINI_TOOL_EXECUTED/);
          const beforeTool = body.contents.flatMap((content: any) => content.parts).filter((part: any) => part.text === "GEMINI_BEFORE_TOOL");
          assert.equal(beforeTool.length, 1, "Native replay must replace, not duplicate, the visible message");
        }
        if (step === 3) {
          const index = body.contents.findIndex((content: any) => content.parts?.some((part: any) => part.thoughtSignature === "synthetic-final-signature"));
          assert.ok(index >= 0, "A signature-only final part survives the client process restart");
          assert.deepEqual(body.contents[index], { role: "model", parts: finalParts });
          assert.equal(body.contents.at(-1).role, "user");
          assert.match(JSON.stringify(body.contents.at(-1).parts), /GEMINI_RESUME_TASK/);
          const answers = body.contents.flatMap((content: any) => content.parts).filter((part: any) => part.text === "GEMINI_DONE");
          assert.equal(answers.length, 1);
        }
        assert.ok(step <= 3, "Only the injected interruption needs a retry");
        const parts = step === 1 ? firstParts : step === 2 ? finalParts : [{ text: "GEMINI_RESUMED" }];
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const part of parts) res.write(formatSse({ candidates: [{ index: 0, content: { role: "model", parts: [part] } }] }));
        res.end(formatSse({
          candidates: [{ index: 0, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 120 },
        }));
      } catch (error) {
        failures.push(error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Synthetic Gemini fixture failed" } }));
      }
    });
    const port = await listen(upstream);
    t.after(() => stop(upstream));
    const config: BridgeConfig = {
      upstreams: { fixture: { base_url: `http://127.0.0.1:${port}/v1beta` } },
      models: { gemini: { upstream: "fixture", model: "synthetic-gemini", catalog: "gemini-3.8-flash" } },
    };
    const bridge = createBridgeServer(config, {
      transformRequest(request) { clientRequests.push(structuredClone(request)); },
    });
    config.port = await listen(bridge);
    t.after(() => stop(bridge));
    const scratch = await mkdtemp(join(tmpdir(), "codeks-gemini-e2e-"));
    t.diagnostic(`Scratch directory: ${scratch}`);
    const home = join(scratch, "home");
    const work = join(scratch, "work");
    await Promise.all([mkdir(home), mkdir(work)]);
    await writeFile(join(home, "config.toml"), [
      "check_for_update_on_startup = false", `model_reasoning_summary = ${JSON.stringify(summary)}`,
      configSnippet(config).replace("[model_providers.bridge.capabilities]", `request_max_retries = 0\nstream_max_retries = ${failure ? 1 : 0}\n[model_providers.bridge.capabilities]`),
    ].join("\n"));
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    const invoke = async (resume: boolean) => {
      const args = resume
        ? ["exec", "resume", "--last", "--skip-git-repo-check", "--json", "GEMINI_RESUME_TASK: confirm the completed work."]
        : ["exec", "--skip-git-repo-check", "--json", "-C", work, "--", "Run the requested Code Mode tool and finish."];
      try {
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
        await writeFile(join(scratch, "requests.json"), JSON.stringify(requests, null, 2));
        assert.deepEqual(failures, []);
        throw error;
      }
    };
    assert.match(await invoke(false), /GEMINI_DONE/);
    assert.equal(requests.length, failure ? 3 : 2);
    assert.match(await invoke(true), /GEMINI_RESUMED/);
    assert.equal(requests.length, failure ? 4 : 3);
    assert.equal(clientRequests.length, requests.length);
    assert.ok(clientRequests.slice(1).every(request => request.input.some((item: any) => item.type === "reasoning" && item.encrypted_content)),
      "Codeks must persist the bridge's opaque state, even when the user hides reasoning summaries");
    if (failure) {
      for (const request of clientRequests.slice(1)) assert.doesNotMatch(JSON.stringify(request.input), /GEMINI_PARTIAL_NOT_PERSISTED/);
      const sessions = join(home, "sessions");
      const paths = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith(".jsonl"));
      const records = (await Promise.all(paths.map(path => readFile(join(sessions, path), "utf8"))))
        .flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
      assert.ok(records.some(record => record.type === "response_item" && record.payload.type === "reasoning"));
      const durableMessages = records.filter(record => record.type === "response_item" && record.payload.type === "message");
      assert.doesNotMatch(JSON.stringify(durableMessages), /GEMINI_PARTIAL_NOT_PERSISTED/,
        "The unfinished text must not become a durable assistant message");
    }
  });
}
