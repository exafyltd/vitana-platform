/**
 * VTID-05070: the `vitana-browser` tool for a Kiro session — read-only screenshots of
 * STAGING, taken by the kiro-browser sidecar (services/kiro-browser), a second container
 * in this Fargate task listening on 127.0.0.1:8090 (KIRO_BROWSER_URL).
 *
 * What kiro-cli gets: one more stdio MCP server, `vitana-browser` (browser-proxy.ts), whose
 * env holds ONLY the localhost URL and a per-session token minted here. No password, no
 * gateway pass, no registry token. The runner registers that token with the sidecar
 * together with the session's gateway pass (the same pass the `vitana` read tools use), so
 * the sidecar can store each PNG on the gateway (POST /api/v1/operator/kiro/media) as this
 * user and thread. The test user's password lives only in the sidecar's own env (an ECS
 * secret of that container); the runner never reads it.
 *
 * Off unless KIRO_BROWSER_URL is a loopback http URL AND KIRO_BROWSER_REGISTRY_TOKEN is set,
 * and only for a session that has a gateway pass.
 */
import path from 'path';
import { randomBytes } from 'crypto';

export interface BrowserConfig { url: string; registryToken: string }

/** The relay program kiro-cli starts as the `vitana-browser` stdio MCP server. */
export const BROWSER_PROXY_PATH = path.join(__dirname, 'browser-proxy.js');

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/?$/;

/** The sidecar config from the environment, or null when screenshots are off. */
export function browserConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserConfig | null {
  const url = env.KIRO_BROWSER_URL ?? '';
  const registryToken = env.KIRO_BROWSER_REGISTRY_TOKEN ?? '';
  if (!LOOPBACK.test(url) || registryToken.length < 16) return null;
  return { url: url.replace(/\/+$/, ''), registryToken };
}

export interface BrowserSession { token: string; close(): void }

type FetchLike = typeof fetch;

/**
 * Mint the session's browser token and register it with the sidecar (fire and forget: a
 * call that arrives before the registration lands is refused by the sidecar as unknown).
 */
export function openBrowserSession(
  cfg: BrowserConfig,
  gatewayPass: string,
  log: (m: string) => void = () => {},
  fetchImpl: FetchLike = fetch,
): BrowserSession {
  const token = randomBytes(32).toString('base64url');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.registryToken}` };
  const call = (method: string, body: unknown) =>
    fetchImpl(`${cfg.url}/sessions`, { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) })
      .then((r) => { if (!r.ok) log(`[kiro-runner] kiro-browser ${method} /sessions answered ${r.status}`); })
      .catch((e) => log(`[kiro-runner] kiro-browser unreachable (${method} /sessions): ${e instanceof Error ? e.message : 'error'}`));
  void call('POST', { session_token: token, gateway_pass: gatewayPass });
  let closed = false;
  return {
    token,
    close() { if (closed) return; closed = true; void call('DELETE', { session_token: token }); },
  };
}

/** The `vitana-browser` MCP server entry: a localhost URL and the session token, nothing else. */
export function browserServerEntry(cfg: BrowserConfig, session: BrowserSession): unknown {
  return {
    name: 'vitana-browser',
    command: process.execPath,
    args: [BROWSER_PROXY_PATH],
    env: [
      { name: 'KIRO_BROWSER_URL', value: cfg.url },
      { name: 'KIRO_BROWSER_SESSION_TOKEN', value: session.token },
    ],
  };
}
