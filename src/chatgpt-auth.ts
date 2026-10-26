import { open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeError } from "./errors.ts";

export const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const LOGIN = 'Run codex -c \'cli_auth_credentials_store="file"\' login with the same CODEX_HOME.';

export interface ChatgptAuthConfig { type: "chatgpt"; codex_home?: string }
export interface ChatgptCredentials { accessToken: string; accountId: string }
interface Snapshot {
  document: Record<string, any>;
  tokens: Record<string, any>;
  credentials: ChatgptCredentials;
}
type RefreshReason = "proactive_expiry" | "scheduled" | "unauthorized_recovery";

const locks = new Map<string, Promise<void>>();
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/[\r\n]/.test(value);
const loginError = (message: string) => new BridgeError(`${message} ${LOGIN}`, "invalid_api_key", 401);
const changedLogin = () => loginError("ChatGPT login changed during authentication. Retry with the selected account.");

async function authPath(auth: ChatgptAuthConfig): Promise<string> {
  const home = auth.codex_home ?? (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  // Preserve shared-file symlinks and serialize aliases of the same credential file.
  try { return await realpath(join(resolve(home), "auth.json")); }
  catch { throw loginError("Cannot read ChatGPT file credentials from auth.json."); }
}

async function readSnapshot(path: string): Promise<Snapshot> {
  let document: any;
  try { document = JSON.parse(await readFile(path, "utf8")); }
  catch { throw loginError("Cannot read ChatGPT file credentials from auth.json."); }
  const mode = document?.auth_mode ?? (document?.OPENAI_API_KEY != null || document?.personal_access_token != null ||
    document?.bedrock_api_key != null || document?.bedrock_access_keys != null ? "other" : "chatgpt");
  const tokens = document?.tokens;
  if (!object(document) || mode !== "chatgpt" || !object(tokens) || !text(tokens.access_token) || !text(tokens.account_id)) {
    throw loginError("auth.json must contain a ChatGPT login with an access token and selected account ID.");
  }
  return { document, tokens, credentials: { accessToken: tokens.access_token, accountId: tokens.account_id } };
}

/** JWT claims are scheduling hints; the saved account ID remains authoritative. */
function claims(token: unknown): Record<string, any> | undefined {
  if (typeof token !== "string") return;
  try {
    const parts = token.split(".");
    const payload = parts.length === 3 ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) : undefined;
    return object(payload) ? payload : undefined;
  } catch { return; }
}

function refreshReason(snapshot: Snapshot): RefreshReason | undefined {
  const exp = claims(snapshot.tokens.access_token)?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) {
    return exp * 1000 <= Date.now() + 5 * 60_000 ? "proactive_expiry" : undefined;
  }
  const refreshed = Date.parse(snapshot.document.last_refresh);
  return Number.isFinite(refreshed) && refreshed < Date.now() - 8 * 86_400_000 ? "scheduled" : undefined;
}

async function locked<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const current = previous.then(() => gate);
  locks.set(path, current);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(path) === current) locks.delete(path); }
}

function sameLogin(left: Snapshot, right: Snapshot): boolean {
  return left.credentials.accountId === right.credentials.accountId &&
    left.tokens.login_owner_id === right.tokens.login_owner_id &&
    claims(left.tokens.id_token)?.["https://api.openai.com/auth"]?.chatgpt_user_id ===
      claims(right.tokens.id_token)?.["https://api.openai.com/auth"]?.chatgpt_user_id;
}

function authority(tokens: Record<string, any>): { issuer: string; client_id: string } {
  const provenance = tokens.oauth_provenance ?? { issuer: DEFAULT_ISSUER, client_id: DEFAULT_CLIENT_ID };
  if (!object(provenance) || !text(provenance.issuer) || !text(provenance.client_id)) {
    throw loginError("ChatGPT OAuth provenance is invalid.");
  }
  let issuer: URL;
  try { issuer = new URL(provenance.issuer); }
  catch { throw loginError("ChatGPT OAuth issuer is invalid."); }
  if (!["https:", "http:"].includes(issuer.protocol) || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw loginError("ChatGPT OAuth issuer is invalid.");
  }
  return { issuer: provenance.issuer.replace(/\/+$/, ""), client_id: provenance.client_id };
}

async function save(path: string, document: Record<string, any>): Promise<void> {
  const temporary = `${path}.bridge-${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(document, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } catch {
    throw new BridgeError("Cannot save refreshed ChatGPT credentials. Check auth.json directory permissions before retrying.", "invalid_prompt", 500);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function refresh(path: string, snapshot: Snapshot, reason: RefreshReason, fetch: typeof globalThis.fetch): Promise<ChatgptCredentials> {
  if (!text(snapshot.tokens.refresh_token)) throw loginError("ChatGPT credentials have no refresh token.");
  const provenance = authority(snapshot.tokens);
  let response: Response;
  try {
    // Refresh tokens rotate. Finish and persist even if the inference request is canceled.
    response = await fetch(`${provenance.issuer}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ grant_type: "refresh_token", client_id: provenance.client_id,
        refresh_token: snapshot.tokens.refresh_token, refresh_reason: reason }),
    });
  } catch { throw new BridgeError("ChatGPT token refresh request failed.", "upstream_error", 502); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // OAuth error bodies can contain credentials; do not forward or capture them.
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw loginError(`ChatGPT token refresh was rejected (HTTP ${response.status}).`);
    }
    throw new BridgeError(`ChatGPT token refresh failed (HTTP ${response.status}).`, "upstream_error", response.status);
  }
  let result: any;
  try { result = await response.json(); }
  catch { throw new BridgeError("ChatGPT token refresh returned invalid JSON.", "upstream_error", 502); }
  if (!object(result) || !text(result.access_token) || ["id_token", "refresh_token"].some(key =>
    result[key] != null && !text(result[key])) || (result.id_token != null && !claims(result.id_token))) {
    throw new BridgeError("ChatGPT token refresh returned invalid credentials.", "upstream_error", 502);
  }
  const current = await readSnapshot(path);
  if (!sameLogin(snapshot, current)) throw changedLogin();
  if (current.tokens.access_token !== snapshot.tokens.access_token || current.tokens.refresh_token !== snapshot.tokens.refresh_token ||
    JSON.stringify(current.tokens.oauth_provenance) !== JSON.stringify(snapshot.tokens.oauth_provenance)) {
    return current.credentials;
  }
  const tokens: Record<string, any> = { ...current.tokens, access_token: result.access_token,
    oauth_provenance: current.tokens.oauth_provenance ?? provenance };
  for (const key of ["id_token", "refresh_token"]) if (result[key] != null) tokens[key] = result[key];
  await save(path, { ...current.document, tokens, last_refresh: new Date().toISOString() });
  return { accessToken: tokens.access_token, accountId: tokens.account_id };
}

export async function getChatgptCredentials(auth: ChatgptAuthConfig, fetch: typeof globalThis.fetch = globalThis.fetch): Promise<ChatgptCredentials> {
  const path = await authPath(auth);
  const initial = await readSnapshot(path);
  if (!refreshReason(initial)) return initial.credentials;
  return locked(path, async () => {
    const current = await readSnapshot(path);
    if (!sameLogin(initial, current)) throw changedLogin();
    const reason = refreshReason(current);
    return reason ? refresh(path, current, reason, fetch) : current.credentials;
  });
}

/** Recover one rejected request, without refreshing credentials another caller already replaced. */
export async function refreshChatgptCredentials(auth: ChatgptAuthConfig, rejected: ChatgptCredentials,
  fetch: typeof globalThis.fetch = globalThis.fetch): Promise<ChatgptCredentials> {
  const path = await authPath(auth);
  return locked(path, async () => {
    const current = await readSnapshot(path);
    if (current.credentials.accountId !== rejected.accountId) throw changedLogin();
    if (current.credentials.accessToken !== rejected.accessToken) return current.credentials;
    return refresh(path, current, "unauthorized_recovery", fetch);
  });
}
