/**
 * VTID-05070: optional sign-in as the E2E test user, for screenshots of signed-in screens.
 *
 * The password is in this container's env only (ECS secret of the kiro-browser container,
 * KIRO_BROWSER_TEST_USER_PASSWORD). The runner and kiro-cli never see it. The sign-in is the
 * Supabase password grant — the one write the staging guard allows — made here in Node, and
 * the resulting session is placed in the page's localStorage on staging hosts only (the same
 * keys the documented Playwright sign-in uses). The session is reused until 5 minutes before
 * it expires. Nothing here is logged except the HTTP status and Supabase's own error code.
 */
export interface SignInConfig {
  supabaseUrl: string;
  email: string;
  password: string;
  /** The publishable (anon) key; when unset it is read from the staging frontend's bundle. */
  anonKey?: string;
  frontendUrl: string;
}

type FetchLike = typeof fetch;

export function signInConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SignInConfig | null {
  const supabaseUrl = env.KIRO_BROWSER_SUPABASE_URL ?? '';
  const password = env.KIRO_BROWSER_TEST_USER_PASSWORD ?? '';
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(supabaseUrl) || !password) return null;
  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
    email: env.KIRO_BROWSER_TEST_USER_EMAIL || 'e2e-test@vitana.dev',
    password,
    anonKey: env.KIRO_BROWSER_SUPABASE_ANON_KEY || undefined,
    frontendUrl: (env.KIRO_BROWSER_FRONTEND_URL || 'https://preview-aws.vitanaland.com').replace(/\/+$/, ''),
  };
}

export function projectRef(supabaseUrl: string): string {
  return new URL(supabaseUrl).hostname.split('.')[0];
}

/** The project's anon key from the staging frontend's index bundle (as the staging specs do). */
export async function anonKeyFromBundle(frontendUrl: string, ref: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const html = await (await fetchImpl(`${frontendUrl}/`, { signal: AbortSignal.timeout(10_000) })).text();
  const src = html.match(/src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1];
  if (!src) return null;
  const bundle = await (await fetchImpl(new URL(src, `${frontendUrl}/`).toString(), { signal: AbortSignal.timeout(10_000) })).text();
  for (const m of bundle.matchAll(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try {
      const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      if (p.role === 'anon' && p.ref === ref) return m[0];
    } catch { /* not a JWT payload */ }
  }
  return null;
}

export class SignIn {
  private cached: { storage: Record<string, string>; until: number } | null = null;

  constructor(private readonly cfg: SignInConfig, private readonly fetchImpl: FetchLike = fetch, private readonly now: () => number = Date.now) {}

  /** localStorage entries of a signed-in test user. Throws an Error with a safe message. */
  async storage(): Promise<Record<string, string>> {
    if (this.cached && this.cached.until > this.now()) return this.cached.storage;
    const ref = projectRef(this.cfg.supabaseUrl);
    const key = this.cfg.anonKey ?? await anonKeyFromBundle(this.cfg.frontendUrl, ref, this.fetchImpl).catch(() => null);
    if (!key) throw new Error('sign-in unavailable: no publishable key found');
    const res = await this.fetchImpl(`${this.cfg.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.cfg.email, password: this.cfg.password }),
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof body?.access_token !== 'string') {
      const code = typeof body?.error_code === 'string' ? body.error_code : typeof body?.error === 'string' ? body.error : '';
      throw new Error(`sign-in rejected: HTTP ${res.status}${code ? ` ${code}` : ''}`);
    }
    const expiresAt = typeof body.expires_at === 'number' ? body.expires_at * 1000 : this.now() + 3_600_000;
    const storage = {
      [`sb-${ref}-auth-token`]: JSON.stringify(body),
      'vitana.authToken': body.access_token as string,
      'vitana.viewRole': 'community',
    };
    this.cached = { storage, until: expiresAt - 5 * 60_000 };
    return storage;
  }
}
