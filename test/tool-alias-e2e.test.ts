import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
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
type Api = "chat" | "messages";
type Reply = { name: string; id: string; input: string } | { text: string };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

function response(api: Api, reply: Reply): Response {
  const isCall = "name" in reply;
  let events: Record<string, any>[];
  if (api === "chat") {
    events = [
      { choices: [{ index: 0, delta: { reasoning_content: "Synthetic tool reasoning." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: isCall ? {
        tool_calls: [{ index: 0, id: reply.id, type: "function", function: { name: reply.name, arguments: JSON.stringify({ input: reply.input }) } }],
      } : { content: reply.text }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: isCall ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 } },
    ];
  } else {
    events = [
      { type: "message_start", message: { id: "msg_alias", type: "message", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Synthetic tool reasoning.", signature: "synthetic-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: isCall ?
        { type: "tool_use", id: reply.id, name: reply.name, input: { input: reply.input } } : { type: "text", text: reply.text } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: isCall ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ];
  }
  return new Response(events.map(event => formatSse(event, event.type)).join("") + (api === "chat" ? "data: [DONE]\n\n" : ""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function replay(body: any, api: Api, id: string): { call: any; result: any } {
  if (api === "chat") return {
    call: body.messages.flatMap((message: any) => message.tool_calls ?? []).find((call: any) => call.id === id),
    result: body.messages.find((message: any) => message.role === "tool" && message.tool_call_id === id),
  };
  const blocks = body.messages.flatMap((message: any) => message.content);
  return {
    call: blocks.find((block: any) => block.type === "tool_use" && block.id === id),
    result: blocks.find((block: any) => block.type === "tool_result" && block.tool_use_id === id),
  };
}

function callName(call: any, api: Api): string {
  return api === "chat" ? call.function.name : call.name;
}

function responsesReply(): Response {
  const item = { type: "message", id: "msg_gpt", role: "assistant", phase: "final_answer",
    content: [{ type: "output_text", text: "ALIAS_DONE" }] };
  const events = [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_gpt", status: "completed", output: [item],
      usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } },
  ];
  return new Response(events.map(event => formatSse(event)).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function fixture(t: TestContext, api: Api, ambiguous: boolean, respond: (body: any, index: number) => Reply,
  checkGpt?: (body: any) => void) {
  const scratch = await mkdtemp(join(tmpdir(), "codeks-tool-alias-e2e-"));
  t.diagnostic(`Scratch directory: ${scratch}`);
  const home = join(scratch, "home");
  const work = join(scratch, "work");
  await Promise.all([mkdir(home), mkdir(work)]);
  const failures: unknown[] = [];
  const requests: any[] = [];
  const gptRequests: any[] = [];
  const clientRequests: any[] = [];
  const delivered: any[] = [];
  const config: BridgeConfig = {
    upstreams: { fake: { base_url: "https://fixture.example/v1" } },
    models: {
      "alias-model": { upstream: "fake", model: "synthetic-model", catalog: api === "chat" ? "deepseek-flash" : "claude-sonnet-5-5" },
      "gpt-model": { upstream: "fake", model: "synthetic-gpt", catalog: "gpt-6-luna" },
    },
  };
  const bridge = createBridgeServer(config, {
    transformRequest(request) {
      clientRequests.push(structuredClone(request));
      if (!ambiguous) return;
      assert.ok(Array.isArray(request.input));
      const declaration = request.input.find(item => item.type === "additional_tools");
      assert.ok(declaration);
      const functions = declaration.tools.find((tool: any) => tool.type === "namespace" && tool.name === "functions");
      const exec = functions?.tools.find((tool: any) => tool.name === "exec");
      assert.ok(exec, "Use the real client's default exec declaration to create a name collision");
      declaration.tools.push({ type: "namespace", name: "other", tools: [structuredClone(exec)] });
    },
    onResponseEvent(_request, event) {
      if (event.type === "response.output_item.done") delivered.push(event.item);
    },
    fetch: async (url, init) => {
      try {
        const body = JSON.parse(String(init?.body));
        if (body.model === "synthetic-gpt") {
          assert.equal(String(url), "https://fixture.example/v1/responses");
          assert.ok(checkGpt, "A model switch must be explicitly exercised by this fixture");
          gptRequests.push(body);
          checkGpt(body);
          return responsesReply();
        }
        assert.equal(String(url), `https://fixture.example/v1/${api === "chat" ? "chat/completions" : "messages"}`);
        const definitions = api === "chat" ? body.tools.map((entry: any) => entry.function) : body.tools;
        const names = definitions.map((entry: any) => entry.name);
        assert.equal(new Set(names).size, names.length, "Each current tool has exactly one top-level definition");
        requests.push(body);
        return response(api, respond(body, requests.length));
      } catch (error) {
        failures.push(error);
        return Response.json({ error: { message: "Synthetic alias fixture failed" } }, { status: 500 });
      }
    },
  });
  config.port = await listen(bridge);
  t.after(async () => {
    bridge.closeAllConnections();
    await new Promise<void>(resolve => bridge.close(() => resolve()));
  });
  await writeFile(join(home, "config.toml"), [
    "check_for_update_on_startup = false",
    configSnippet(config).replace("[model_providers.bridge.capabilities]", "request_max_retries = 0\nstream_max_retries = 0\n[model_providers.bridge.capabilities]"),
  ].join("\n"));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  try {
    const pending = run(binary!, ["exec", "--skip-git-repo-check", "--json", "-C", work, "-s", "workspace-write", "--", "SYNTHETIC_ALIAS_TASK: run the requested tool and finish."], {
      cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    await writeFile(join(scratch, "exec.stdout"), stdout);
    assert.deepEqual(failures, [], "Synthetic upstream assertions");
    assert.match(stdout, /ALIAS_DONE/);
    assert.ok(stdout.split("\n").some(line => line && JSON.parse(line).type === "turn.completed"), stdout);
    const resumed = run(binary!, ["exec", "resume", "--last", "--skip-git-repo-check", "--json", "SYNTHETIC_ALIAS_RESUME: confirm the completed work."], {
      cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    });
    resumed.child.stdin?.end();
    const resumedOutput = await resumed;
    await writeFile(join(scratch, "resume.stdout"), resumedOutput.stdout);
    assert.deepEqual(failures, [], "Persisted history replay assertions");
    assert.match(resumedOutput.stdout, /ALIAS_DONE/);
    assert.match(JSON.stringify(requests.at(-1).messages), /SYNTHETIC_ALIAS_RESUME/);
    if (checkGpt) {
      for (const [model, prompt] of [
        ["gpt-model", "SYNTHETIC_GPT_SWITCH: confirm the completed work."],
        ["gpt-model", "SYNTHETIC_GPT_RESUME: confirm the same history again."],
        ["alias-model", "SYNTHETIC_SWITCH_BACK: confirm the completed work."],
      ]) {
        const switched = run(binary!, ["exec", "resume", "--last", "--model", model, "--skip-git-repo-check", "--json", prompt], {
          cwd: work, env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
        });
        switched.child.stdin?.end();
        const output = await switched;
        await writeFile(join(scratch, `${prompt.split(":")[0]}.stdout`), output.stdout);
        assert.deepEqual(failures, [], "Cross-model history replay assertions");
        assert.match(output.stdout, /ALIAS_DONE/);
        assert.ok(output.stdout.split("\n").some(line => line && JSON.parse(line).type === "turn.completed"), output.stdout);
      }
    }
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    await writeFile(join(scratch, "failure.txt"), `${output.stdout ?? ""}\n${output.stderr ?? ""}`);
    assert.deepEqual(failures, [], "Synthetic upstream assertions");
    throw error;
  }
  await assert.rejects(access(join(work, "wrong-tool-executed.txt")), { code: "ENOENT" });
  return { requests, gptRequests, clientRequests, delivered, work };
}

for (const api of ["chat", "messages"] as const) {
  test(`real codeks ${api}: aliases and tool errors survive resume, GPT switch and switch back`, { skip: !binary, timeout: 120_000 }, async t => {
    const { requests, gptRequests, clientRequests, delivered } = await fixture(t, api, false, (body, step) => {
      if (step === 1) return { name: "exec", id: "call_bare", input: 'text(await tools.exec_command({cmd: "printf BARE_ALIAS_OK", yield_time_ms: 1000}));' };
      const bare = replay(body, api, "call_bare");
      assert.equal(callName(bare.call, api), "exec", "Replay keeps the name originally returned by the model");
      assert.match(JSON.stringify(bare.result), /BARE_ALIAS_OK/);
      if (step === 2) return { name: "functions.exec", id: "call_dotted", input: 'text(await tools.exec_command({cmd: "printf DOTTED_ALIAS_OK", yield_time_ms: 1000}));' };
      const dotted = replay(body, api, "call_dotted");
      assert.equal(callName(dotted.call, api), "functions.exec");
      assert.match(JSON.stringify(dotted.result), /DOTTED_ALIAS_OK/);
      if (step === 3) return { name: "missing_tool", id: "call_unknown", input: 'text(await tools.exec_command({cmd: "printf wrong > wrong-tool-executed.txt"}));' };
      assert.ok(step >= 4 && step <= 6, "Initial completion, persisted resume and switch back each use one request");
      const unknown = replay(body, api, "call_unknown");
      assert.equal(callName(unknown.call, api), "missing_tool");
      assert.match(JSON.stringify(unknown.result), /unknown.*No tool was executed/);
      assert.match(JSON.stringify(unknown.result), /functions__exec/);
      if (api === "messages") assert.equal(unknown.result.is_error, true);
      return { text: "ALIAS_DONE" };
    }, body => {
      const calls = body.input.filter((item: any) => ["function_call", "custom_tool_call"].includes(item.type));
      const results = body.input.filter((item: any) => ["function_call_output", "custom_tool_call_output"].includes(item.type));
      assert.equal(calls.length, 3);
      assert.equal(results.length, 3);
      assert.equal(new Set(calls.map((call: any) => call.call_id)).size, 3, "Distinct persisted calls remain distinct");
      for (const item of [...calls, ...results]) {
        assert.ok(typeof item.call_id === "string" && item.call_id.length <= 64, "Responses call_id must fit the upstream limit");
      }
      for (const call of calls) {
        const result = results.find((item: any) => item.call_id === call.call_id);
        assert.ok(result, "Responses calls and outputs must use the same projected ID");
        if (call.type === "custom_tool_call") {
          assert.equal(call.namespace, "functions");
          assert.equal(call.name, "exec", "GPT keeps the canonical Responses tool identity");
          assert.equal(result.type, "custom_tool_call_output");
          assert.match(call.input, /(?:BARE|DOTTED)_ALIAS_OK/);
          assert.match(JSON.stringify(result.output), /(?:BARE|DOTTED)_ALIAS_OK/);
        } else {
          assert.equal(call.namespace, "codeks_bridge_tool_error");
          assert.equal(call.name, "invalid_call");
          assert.match(JSON.stringify(result.output), /unknown.*No tool was executed/);
          assert.match(JSON.stringify(result.output), /functions__exec/);
        }
      }
    });
    assert.equal(requests.length, 6, "Four tool-loop requests, one persisted resume and one switch back, without retries");
    assert.equal(gptRequests.length, 2, "The GPT switch and subsequent turn each use one request");
    const ids = (body: any) => body.input.filter((item: any) => typeof item.call_id === "string").map((item: any) => item.call_id);
    assert.deepEqual(ids(gptRequests[0]), ids(gptRequests[1]), "Projected IDs stay stable on later turns");
    const persistedIds = ids(clientRequests.find(request => request.model === "gpt-model"));
    assert.ok(persistedIds.every((id: string) => id.startsWith("cxbt1_")), "The client retains the original replay carriers");
    ids(gptRequests[0]).forEach((id: string, index: number) => {
      if (persistedIds[index].length <= 64) assert.equal(id, persistedIds[index], "Valid short carrier ids remain unchanged");
      else assert.notEqual(id, persistedIds[index], "Long carrier ids are shortened before Responses replay");
    });
    assert.deepEqual(ids(clientRequests.at(-1)), persistedIds, "Switching to GPT must not rewrite the stored source history");
    assert.match(JSON.stringify(requests.at(-1).messages), /SYNTHETIC_SWITCH_BACK/);
    const declarations = clientRequests.at(-1).input
      .filter((item: any) => item.type === "additional_tools")
      .flatMap((item: any) => item.tools)
      .filter((tool: any) => tool.type === "namespace" && tool.name === "functions")
      .flatMap((namespace: any) => namespace.tools)
      .filter((tool: any) => tool.name === "exec");
    assert.ok(new Set(declarations.map((tool: any) => tool.description)).size >= 2,
      "The real client changes exec's nested tool description when switching models");
    const definitions = api === "chat" ? requests.at(-1).tools.map((entry: any) => entry.function) : requests.at(-1).tools;
    const exec = definitions.find((tool: any) => tool.name === "functions__exec");
    assert.ok(exec.description.startsWith(declarations.at(-1).description), "Switch-back uses the latest exec definition");
    const calls = delivered.filter(item => item.type === "custom_tool_call");
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.name === "exec" && call.namespace === "functions" && call.call_id.startsWith("cxbt1_")));
  });

  test(`real codeks ${api}: ambiguous bare exec cannot execute the default tool and can be corrected`, { skip: !binary, timeout: 120_000 }, async t => {
    const { requests, delivered, work } = await fixture(t, api, true, (body, step) => {
      if (step === 1) return { name: "exec", id: "call_ambiguous", input: 'text(await tools.exec_command({cmd: "printf wrong > wrong-tool-executed.txt"}));' };
      const ambiguous = replay(body, api, "call_ambiguous");
      assert.equal(callName(ambiguous.call, api), "exec");
      assert.match(JSON.stringify(ambiguous.result), /ambiguous.*No tool was executed/);
      assert.match(JSON.stringify(ambiguous.result), /functions__exec/);
      assert.match(JSON.stringify(ambiguous.result), /other__exec/);
      if (step === 2) return { name: "functions__exec", id: "call_corrected", input: 'text(await tools.exec_command({cmd: "printf correct > corrected-tool.txt", yield_time_ms: 1000}));' };
      assert.ok(step === 3 || step === 4, "Only one model request is needed to resume");
      assert.ok(replay(body, api, "call_corrected").result);
      return { text: "ALIAS_DONE" };
    });
    assert.equal(requests.length, 4);
    assert.equal(await readFile(join(work, "corrected-tool.txt"), "utf8"), "correct");
    const failed = delivered.find(item => item.namespace === "codeks_bridge_tool_error");
    assert.equal(failed.type, "function_call");
    assert.equal(failed.name, "invalid_call");
    assert.equal(delivered.filter(item => item.type === "custom_tool_call").length, 1);
  });
}
