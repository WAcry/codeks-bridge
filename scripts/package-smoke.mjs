import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";

const [argument, ...extra] = process.argv.slice(2);
assert(argument && extra.length === 0, "Usage: node scripts/package-smoke.mjs /path/to/package.tgz");
const tarball = resolve(argument);
assert((await stat(tarball)).isFile(), "Package tarball must be a file");
const directory = await mkdtemp(join(tmpdir(), "codeks-bridge-package-"));
console.log(`Package smoke evidence: ${directory}`);

const npm = process.env.npm_execpath;
const executable = npm ? process.execPath : "npm";
const environment = { ...process.env };
delete environment.NODE_AUTH_TOKEN;
delete environment.NPM_TOKEN;
execFileSync(executable, [
  ...(npm ? [npm] : []), "install", "--prefix", directory,
  "--registry=https://registry.npmjs.org", "--ignore-scripts", "--no-audit", "--no-fund",
  "--package-lock=false", "--no-save", tarball,
], { stdio: "inherit", env: environment, timeout: 120_000 });

const require = createRequire(join(directory, "consumer.cjs"));
const entry = require.resolve("@wacry/codeks-bridge");
const root = dirname(dirname(entry));
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(metadata.name, "@wacry/codeks-bridge");
assert.equal(metadata.exports["."], "./dist/index.js");
assert.equal(metadata.bin["codeks-bridge"], "dist/cli.js");
assert.equal(metadata.types, "./dist/index.d.ts");
assert((await readFile(join(root, metadata.types))).length > 0, "Public type declarations must be packaged");
assert((await stat(join(directory, "node_modules", ".bin", process.platform === "win32" ? "codeks-bridge.cmd" : "codeks-bridge"))).isFile(), "npm must install the CLI entry point");
assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0, "The runtime package must have no dependencies");
for (const file of ["README.md", "LICENSE", "NOTICE", "catalog/README.md", "docs/design.md", "docs/config.md", "examples/config.json"]) {
  assert((await readFile(join(root, file))).length > 0, `${file} must be packaged`);
}
const bridge = await import(pathToFileURL(entry).href);
for (const name of ["createBridgeServer", "loadConfig", "validateConfig", "resolveModel", "buildCatalog", "configSnippet", "BridgeError"]) {
  assert.equal(typeof bridge[name], "function", `Missing public export: ${name}`);
}

const config = {
  host: "127.0.0.1", port: 0, compaction_cache_dir: join(directory, "compactions"),
  upstreams: { synthetic: { base_url: "http://127.0.0.1:1/v1" } },
  models: {
    gpt: { upstream: "synthetic", catalog: "gpt-6.1-sol", model: "synthetic-gpt" },
    claude: { upstream: "synthetic", catalog: "claude-sonnet-5-5", model: "synthetic-claude" },
    flash: { upstream: "synthetic", catalog: "deepseek-flash", model: "synthetic-flash" },
    memory: { upstream: "synthetic", catalog: "gpt-5.6-luna", model: "synthetic-memory", visibility: "hide" },
    ...Object.fromEntries(["gpt-6.1-terra", "gpt-5.5", "gpt-daybreak-blue-latest", "gpt-daybreak-red-latest", "codex-auto-review", "gpt-reserve"].map(key => [
      key, { upstream: "synthetic", catalog: key, model: key, visibility: "hide" },
    ])),
  },
};
const configPath = join(directory, "bridge.json");
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const consumerPath = join(directory, "consumer.mts");
await writeFile(consumerPath, `import { createBridgeServer, type BridgeConfig, type BridgeServerOptions, type ResponsesRequest } from "@wacry/codeks-bridge";
const config: BridgeConfig = ${JSON.stringify(config)};
const options: BridgeServerOptions = {
  fetch: globalThis.fetch,
  async transformRequest(request: ResponsesRequest, { headers }) {
    return { ...request, model: headers.get("x-example-model") ?? request.model };
  },
  onResponseEvent(request, event) { console.log(request.model, event.type); },
};
const server = createBridgeServer(config, options);
server.close();
`);
const development = createRequire(import.meta.url);
execFileSync(process.execPath, [
  development.resolve("typescript/lib/tsc.js"), "--noEmit", "--strict", "--target", "ES2023",
  "--module", "NodeNext", "--moduleResolution", "NodeNext", "--types", "node",
  "--typeRoots", dirname(dirname(development.resolve("@types/node/package.json"))), consumerPath,
], { cwd: directory, stdio: "inherit", timeout: 30_000 });
const cli = join(root, metadata.bin["codeks-bridge"]);
const command = (...args) => execFileSync(process.execPath, [cli, ...args], {
  cwd: directory, encoding: "utf8", timeout: 30_000,
});
assert.match(command("--help"), /Usage: codeks-bridge/);
const catalog = JSON.parse(command("catalog", "--config", configPath));
assert.deepEqual(catalog.models.map((model) => model.slug), Object.keys(config.models));
for (const model of catalog.models) {
  assert(model.model_messages.instructions_template.length > 100, `Missing instructions for ${model.slug}`);
  assert.equal(model.visibility, config.models[model.slug].visibility ?? "list");
}
assert.match(command("config-snippet", "--config", configPath), /remote_compaction = "v2"/);

const events = [];
let upstreamRequests = 0;
const server = bridge.createBridgeServer(await bridge.loadConfig(configPath), {
  async transformRequest(request, { headers }) {
    return { ...request, model: headers.get("x-example-model") ?? request.model };
  },
  async fetch(_url, init) {
    upstreamRequests++;
    const body = JSON.parse(init.body);
    assert.equal(body.model, "synthetic-gpt");
    assert.equal(body.input[0].content[0].text, "Hello");
    return Response.json({
      id: "resp_synthetic", status: "completed",
      output: [{ type: "function_call", id: "fc_synthetic", call_id: "call_synthetic", name: "read", arguments: "{}" }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  },
  onResponseEvent(request, event) {
    assert.equal(request.model, "gpt");
    events.push(event);
  },
});
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const get = async (path) => {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, `GET ${path}`);
    return response;
  };
  assert.deepEqual(await (await get("/health")).json(), { status: "ok" });
  assert.deepEqual(await (await get("/v1/models")).json(), catalog);
  const state = await (await get("/inspect/api/state")).json();
  assert.equal(state.capturing, false);

  for (const stream of [false, true]) {
    events.length = 0;
    const response = await fetch(new URL("/v1/responses", base), {
      method: "POST", headers: { "content-type": "application/json", "x-example-model": "gpt" },
      body: JSON.stringify({ model: "replaced-by-host", input: "Hello", stream }),
    });
    assert.equal(response.status, 200);
    if (stream) {
      const frames = (await response.text()).split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.slice(6)));
      assert.deepEqual(frames, events);
    } else {
      assert.deepEqual(await response.json(), events.at(-1).response);
    }
    assert.equal(events.at(-1).type, "response.completed");
    assert.equal(events.filter(event => event.type === "response.output_item.done").length, 1);
  }
  assert.equal(upstreamRequests, 2);

  // Follow the installed page's local module graph to catch omitted UI assets.
  const pending = [new URL("/inspect/", base)];
  const visited = new Set();
  while (pending.length) {
    const url = pending.pop();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    assert.equal(url.origin, base);
    assert(url.pathname.startsWith("/inspect/"));
    const response = await get(url.pathname);
    const body = await response.text();
    assert(body.length > 0, `Empty UI asset: ${url.pathname}`);
    const local = url.pathname === "/inspect/" ? "index.html" : url.pathname.slice("/inspect/".length);
    assert.equal(body, await readFile(join(root, "ui", local), "utf8"));
    const references = local.endsWith(".html")
      ? [...body.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1])
      : local.endsWith(".js")
        ? [...body.matchAll(/\b(?:from\s*|import\s*)["'](\.[^"']+)["']/g)].map(match => match[1])
        : [];
    for (const reference of references) pending.push(new URL(reference, url));
  }
  assert(visited.size >= 4, "Inspector page must load its script, stylesheet, and icon");
  console.log(`Verified ${metadata.name}@${metadata.version} on ${process.version}: exports, consumer types, CLI, catalog, embedded SSE/JSON, and ${visited.size} inspector assets`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
