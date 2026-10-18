import assert from "node:assert/strict";
import test from "node:test";
import { buildAnthropicRequest } from "../src/backends/anthropic.ts";
import { buildDeepSeekRequest } from "../src/backends/deepseek.ts";
import { resolveModel, validateConfig } from "../src/config.ts";
import { prepareHistory } from "../src/history.ts";
import { translateToolHistory } from "../src/tool-history.ts";

const config = validateConfig({
  upstreams: { example: { base_url: "https://api.example.com/v1" } },
  models: {
    gpt: { upstream: "example", model: "gpt-6.1-sol", catalog: "gpt-6.1-sol" },
    claude: { upstream: "example", model: "claude-sonnet-5-5", catalog: "claude-sonnet-5-5" },
    deepseek: { upstream: "example", model: "deepseek-flash", catalog: "deepseek-flash" },
  },
});
const call = (id: string) => ({ type: "custom_tool_call", call_id: id, namespace: "functions", name: "exec", input: "text('done')" });
const result = (id: string, output: unknown = `Result ${id}`) => ({ type: "custom_tool_call_output", call_id: id, output });
const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const image = { type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" };
const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Execute code." }] }];

test("named standalone outputs become attributed user notifications with all content", () => {
  const input = [{
    type: "function_call_output", namespace: "events", name: "task_finished",
    output: [{ type: "input_text", text: "The task completed." }, image],
  }];
  for (const model of ["claude", "deepseek"]) {
    const [notification] = prepareHistory(input, resolveModel(config, model));
    assert.equal(notification.role, "user");
    assert.equal(notification.content[0].text, 'Tool notification from {"namespace":"events","name":"task_finished"}:\n');
    assert.deepEqual(notification.content.slice(1), input[0].output);
  }
  assert.deepEqual(prepareHistory(input, resolveModel(config, "gpt")), input);
});

test("complete parallel exchanges place reminders after every corresponding result", () => {
  const reminder = message("user", "<image_resize_notice>Image A was resized.</image_resize_notice>");
  const developer = message("developer", "Keep the current branch.");
  const input = [message("user", "Read both files."), call("a"), call("b"), developer, result("a"), reminder, result("b")];
  assert.deepEqual(translateToolHistory(input), [input[0], input[1], input[2], input[4], input[6], developer, reminder]);
  assert.deepEqual(prepareHistory(input, resolveModel(config, "gpt")), input);
});

test("agent messages between a call and its result retain content and attribution after the exchange", () => {
  const agent = { type: "agent_message", author: "/root/worker", recipient: "/root", content: [{ type: "input_text", text: "The check passed." }, image] };
  const input = [call("a"), agent, result("a")];
  for (const model of ["claude", "deepseek"]) {
    const selected = prepareHistory(input, resolveModel(config, model));
    assert.deepEqual(selected.slice(0, 2), [input[0], input[2]]);
    assert.equal(selected[2].content[0].text, 'Agent message from "/root/worker" to "/root":\n');
    assert.deepEqual(selected[2].content.slice(1), agent.content);
  }
});

test("incremental notify output preserves the first result and the previously translated prefix", () => {
  const first = [call("exec_one"), result("exec_one", "First progress")];
  const secondOutput = result("exec_one", [{ type: "input_text", text: "Second progress" }, image]);
  const second = [...first, secondOutput];
  const final = [...second, result("exec_one", "Final result")];
  const translated = translateToolHistory(final);
  assert.deepEqual(translateToolHistory(second).slice(0, first.length), translateToolHistory(first));
  assert.deepEqual(translated.slice(0, second.length), translateToolHistory(second));
  assert.deepEqual(translated.slice(0, 2), first);
  assert.equal(translated[2].role, "user");
  assert.match(translated[2].content[0].text, /exec_one.*functions.*exec/);
  assert.deepEqual(translated[2].content.slice(1), secondOutput.output);
  assert.equal(translated[3].content[1].text, "Final result");
  assert.deepEqual(prepareHistory(final, resolveModel(config, "gpt")), final);
});

test("notifications inside a parallel exchange follow its results without losing later output", () => {
  const input = [call("a"), call("b"), result("a", "Progress"), result("a", "Complete"), result("b")];
  const translated = translateToolHistory(input);
  assert.deepEqual(translated.slice(0, 4), [input[0], input[1], input[2], input[4]]);
  assert.equal(translated[4].content[1].text, "Complete");
  assert.deepEqual(translateToolHistory([...input, result("a", "Late output")]).slice(0, translated.length), translated);
});

test("translation preserves model block order, separate exchanges, and incomplete history", () => {
  const thought = { type: "bridge_reasoning", state: { data: "signed" } };
  const complete = [call("a"), thought, call("b"), result("a"), result("b")];
  assert.deepEqual(translateToolHistory(complete), complete);
  const separate = [call("a"), result("a"), message("user", "Next task."), call("b"), result("b")];
  assert.deepEqual(translateToolHistory(separate), separate);
  const incomplete = [call("a"), call("b"), result("a"), message("user", "An intervening message."), thought, result("b")];
  assert.deepEqual(translateToolHistory(incomplete), incomplete);
  const missing = [call("a"), message("user", "Cancelled.")];
  assert.deepEqual(translateToolHistory(missing), missing);
  assert.deepEqual(translateToolHistory([result("unknown")]), [result("unknown")]);
});

test("translated backend requests have adjacent results followed by reminder and image content", () => {
  const input = [message("user", "Read both images."), call("a"), call("b"), result("a", [{ type: "input_text", text: "First image" }, image]), message("user", "Image A was resized."), result("b"), result("a", "More progress")];
  const original = structuredClone(input);
  const context = (model: string) => ({ route: resolveModel(config, model), request: { model, input, tools }, signal: new AbortController().signal });
  const claude = buildAnthropicRequest(context("claude")).body;
  const content = claude.messages[2].content;
  assert.deepEqual(content.slice(0, 2).map((part: any) => part.type), ["tool_result", "tool_result"]);
  assert(content.slice(2).every((part: any) => part.type === "text"));
  assert.equal(content[0].content[1].type, "image");
  assert.match(JSON.stringify(content), /More progress/);
  const deepseek = buildDeepSeekRequest(context("deepseek")).body;
  assert.deepEqual(deepseek.messages.slice(0, 4).map((item: any) => item.role), ["user", "assistant", "tool", "tool"]);
  assert(deepseek.messages.slice(4).every((item: any) => item.role === "user"));
  assert.match(JSON.stringify(deepseek.messages), /Images from tool call a/);
  assert.match(JSON.stringify(deepseek.messages), /More progress/);
  assert.deepEqual(input, original);
});
