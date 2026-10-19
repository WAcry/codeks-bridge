import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Api, UpstreamConfig } from "./types.ts";
import { BridgeError } from "./errors.ts";
import { forwardRequestHeaders } from "./headers.ts";
const execute = promisify(execFile);

export async function upstreamHeaders(config: UpstreamConfig, api: Api, signal: AbortSignal, clientHeaders?: Headers): Promise<Headers> {
  const headers = forwardRequestHeaders(clientHeaders, config.auth_header);
  for (const [name, value] of Object.entries(config.headers ?? {})) headers.set(name, value);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (api === "anthropic" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  let credential: string | undefined;
  if (config.api_key_env) {
    credential = process.env[config.api_key_env]?.trim();
    if (!credential) throw new BridgeError(`Missing credential environment variable: ${config.api_key_env}`);
  } else if (config.api_key_command) {
    const [command, ...args] = config.api_key_command;
    try {
      const result = await execute(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, signal });
      credential = result.stdout.trim();
    } catch {
      if (signal.aborted) throw signal.reason;
      // execFile errors include stdout/stderr. Never forward those to a client.
      throw new BridgeError("Credential command failed");
    }
    if (!credential) throw new BridgeError("Credential command returned an empty credential");
  }
  if (credential) {
    if (/[\r\n]/.test(credential)) throw new BridgeError("Credential must be a single line");
    const header = config.auth_header ?? (api === "anthropic" ? "x-api-key" : "authorization");
    headers.set(header, header.toLowerCase() === "authorization" ? `Bearer ${credential}` : credential);
  }
  return headers;
}
