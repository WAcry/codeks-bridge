#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { createBridgeServer } from "./server.ts";
import { buildCatalog, configSnippet } from "./catalog.ts";

const HELP = `Usage: codeks-bridge <command> --config <file> [options]

Commands:
  serve           Start the local Responses API server
  catalog         Export the configured model catalog for codeks
  config-snippet  Print the codeks provider configuration

Options:
  --output <file>        Write catalog JSON (otherwise stdout)
  --catalog <file>       Use a static catalog instead of HTTP discovery
  --help                Show this help
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: "string" }, output: { type: "string" },
    catalog: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help || positionals.length === 0) { process.stdout.write(HELP); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !["serve", "catalog", "config-snippet"].includes(command)) throw new Error("Unknown command. Use --help.");
  if (!values.config) throw new Error("--config is required");
  const config = await loadConfig(values.config);
  if (command === "catalog") {
    const text = JSON.stringify(buildCatalog(config), null, 2) + "\n";
    if (values.output) await writeFile(values.output, text, { mode: 0o600 });
    else process.stdout.write(text);
  } else if (command === "config-snippet") {
    process.stdout.write(configSnippet(config, values.catalog ? resolve(values.catalog) : undefined));
  } else {
    const server = createBridgeServer(config);
    server.on("error", error => { process.stderr.write(`Server error: ${error.message}\n`); process.exitCode = 1; });
    server.listen(config.port ?? 8787, config.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : config.port;
      process.stderr.write(`Listening on ${config.host ?? "127.0.0.1"}:${port}\n`);
    });
    const stop = () => { server.close(); server.closeAllConnections(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Command failed"}\n`); process.exitCode = 1; });
