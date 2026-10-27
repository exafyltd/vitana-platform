/**
 * VTID-05352 (plan pm-ci-load, lane pm-app-token) — a GitHub App installation token for the Project Manager.
 *
 * Why: the PM's REST calls used the `exafyltd` user's PAT (GITHUB_SAFE_MERGE_TOKEN / FRONTEND_DEPLOY_TOKEN), the same
 * user every Kiro Web session and PLATFORM_DISPATCH_TOKEN act as, so they shared one 5,000/h REST budget (55 vitana-v1
 * Lane-scope failures in 14 days were `API rate limit exceeded` for that user). An App installation token has its own
 * limit and expires after an hour.
 *
 * Off unless PM_GITHUB_APP_ID, PM_GITHUB_APP_PRIVATE_KEY (PEM; escaped `\n` accepted) and
 * PM_GITHUB_APP_INSTALLATION_ID are all set. A failed exchange logs one line (`pm.github_app.token_failed`, status
 * only, never key, JWT or token) and returns null, so the caller keeps using today's token and the PM never stops on
 * the App. The token lives in memory only.
 */
import { SignJWT, importPKCS8 } from 'jose';

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
/** Refresh this long before `expires_at`. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Least privilege (plan §4): every PM call is one of contents, git refs, pulls, check-runs or actions/variables. */
export const PM_APP_PERMISSIONS = Object.freeze({
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  actions_variables: 'read',
  metadata: 'read',
} as const);
export const PM_APP_REPOSITORIES: readonly string[] = Object.freeze(['vitana-platform', 'vitana-v1']);

export interface AppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

export interface AppTokenSource {
  /** The installation token, or null when it cannot be had right now (the caller falls back). */
  get(): Promise<string | null>;
}

export function appConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig | null {
  const appId = (env.PM_GITHUB_APP_ID || '').trim();
  const key = env.PM_GITHUB_APP_PRIVATE_KEY || '';
  const installationId = (env.PM_GITHUB_APP_INSTALLATION_ID || '').trim();
  if (!appId || !key.trim() || !installationId) return null;
  return { appId, privateKey: key.includes('\\n') ? key.replace(/\\n/g, '\n') : key, installationId };
}

interface Deps {
  fetch: typeof fetch;
  now: () => number;
  log: (line: string) => void;
}

export function createAppTokenSource(cfg: AppConfig, deps: Partial<Deps> = {}): AppTokenSource {
  const d: Deps = {
    fetch: deps.fetch ?? fetch,
    now: deps.now ?? Date.now,
    log: deps.log ?? ((l) => console.warn(l)),
  };
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string | null> | null = null;

  async function exchange(): Promise<string | null> {
    try {
      const nowS = Math.floor(d.now() / 1000);
      const key = await importPKCS8(cfg.privateKey, 'RS256');
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(cfg.appId)
        .setIssuedAt(nowS - 60)
        .setExpirationTime(nowS + 9 * 60)
        .sign(key);
      const res = await d.fetch(`${GITHUB_API}/app/installations/${encodeURIComponent(cfg.installationId)}/access_tokens`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ repositories: PM_APP_REPOSITORIES, permissions: PM_APP_PERMISSIONS }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        d.log(JSON.stringify({ event: 'pm.github_app.token_failed', status: res.status }));
        return null;
      }
      const data = (await res.json()) as { token?: unknown; expires_at?: unknown };
      const expiresAt = Date.parse(String(data.expires_at || ''));
      if (typeof data.token !== 'string' || !data.token || Number.isNaN(expiresAt)) {
        d.log(JSON.stringify({ event: 'pm.github_app.token_failed', status: res.status, reason: 'malformed response' }));
        return null;
      }
      cached = { token: data.token, expiresAt };
      return data.token;
    } catch (e) {
      d.log(JSON.stringify({ event: 'pm.github_app.token_failed', status: 0, reason: e instanceof Error ? e.name : 'error' }));
      return null;
    }
  }

  return {
    async get() {
      if (cached && d.now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
      if (!inflight) inflight = exchange().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

let defaultSource: AppTokenSource | null | undefined;
/** The process-wide source from the environment (null when the App is not configured). */
export function defaultAppTokenSource(): AppTokenSource | null {
  if (defaultSource === undefined) {
    const cfg = appConfigFromEnv();
    defaultSource = cfg ? createAppTokenSource(cfg) : null;
  }
  return defaultSource;
}
