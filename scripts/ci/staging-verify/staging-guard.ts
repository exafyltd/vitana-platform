// VTID-04613 — read-only network guard for STAGING-VERIFY browser tests.
//
// CANONICAL COPY. run.mjs copies this file next to every *.staging.spec.ts
// before it runs, so a repo can never carry a stale or weakened guard. Specs
// import it as:
//
//   import { test, expect } from './staging-guard';
//
// Why: staging frontends and the staging gateway write to the PRODUCTION
// Supabase project (CLAUDE.md rules 31–32/48). A browser test that clicks
// "post", "like" or "save" on staging writes in front of real members. The
// guard
//   - aborts every non-read request to a gateway or to Supabase, except
//     signing in;
//   - aborts EVERY request to a production host — a staging build must never
//     talk to production (VTID-04616 was exactly that);
// and fails the test if it had to abort anything the test did not declare as
// expected (a telemetry beacon, say) via ONE RegExp — alternate with | for
// several:
//
//   test.use({ allowAbortedWrites: /\/api\/v1\/rum\/beacon|\/api\/v1\/diag\/notif-tap/ });
//
// Never pass an array of two or more RegExps: Playwright reads any array whose
// second element is an object as a [value, options] fixture tuple, so
// [a, b] would silently become just `a` (VTID-04613, first live run).

import { test as base, expect } from '@playwright/test';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Where data lives: every gateway (staging, production, DR) and Supabase.
const GUARDED_HOST = /(^|\.)supabase\.co$|gateway\.vitanaland\.com$/;
// Mirror of PRODUCTION_HOSTS in lib.cjs.
const PRODUCTION_HOST = /^(vitanaland\.com|www\.vitanaland\.com|gateway\.vitanaland\.com|dr-app\.vitanaland\.com|dr-gateway\.vitanaland\.com)$/;
const ALWAYS_ALLOWED_WRITES = [/\/auth\/v1\/token(\?|$)/];

// VTID-05129 — requests the app fires on almost every page that this guard
// aborts but no spec should fail on. Each entry matches ONE blocked record
// exactly ("METHOD URL", anchored), so a production-host record (suffixed
// " (production host)") never matches. They STAY ABORTED; only the failure is
// tolerated. MIRROR of DEFAULT_ALLOWED_ABORTS in lib.cjs — lib.test.cjs fails
// if the two differ. A spec adds its own entries via allowAbortedWrites.
const DEFAULT_ALLOWED_ABORTS: RegExp[] = [
  // Telemetry beacons (fire-and-forget).
  /^POST https:\/\/preview-aws-gateway\.vitanaland\.com\/api\/v1\/rum\/beacon(\?[^ ]*)?$/,
  /^POST https:\/\/preview-aws-gateway\.vitanaland\.com\/api\/v1\/diag\/notif-tap(\?[^ ]*)?$/,
  /^POST https:\/\/preview-aws-gateway\.vitanaland\.com\/api\/v1\/analytics\/events\/batch(\?[^ ]*)?$/,
  // Voice widget warm-up on load (useOrbVoiceWidget) — only this path.
  /^POST https:\/\/preview-aws-gateway\.vitanaland\.com\/api\/v1\/orb\/live\/session\/prewarm(\?[^ ]*)?$/,
  // Chat presence and the activity log.
  /^(POST|PATCH) https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/rest\/v1\/thread_presence(\?[^ ]*)?$/,
  /^POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/rest\/v1\/user_activity_log(\?[^ ]*)?$/,
  // Read-only RPCs and functions (supabase-js sends rpc/invoke as POST).
  /^POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/rest\/v1\/rpc\/(get_role_preference|get_my_permitted_roles|list_roles_for_active_tenant|get_profile_health_summary|get_user_profile_by_identifier)(\?[^ ]*)?$/,
  /^POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/functions\/v1\/list_my_memberships(\?[^ ]*)?$/,
  // Real production writes fired app-wide on load, never a spec's subject:
  // the daily Vitana Index upsert and daily match generation. The guard
  // aborts them; specs only stop failing on that abort.
  /^POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/rest\/v1\/rpc\/health_compute_vitana_index(\?[^ ]*)?$/,
  /^POST https:\/\/inmkhvwdcuyhnxkgfvsb\.supabase\.co\/functions\/v1\/generate-daily-matches(\?[^ ]*)?$/,
];

type GuardOptions = { allowAbortedWrites: RegExp | RegExp[] | null };
type GuardFixtures = { stagingGuard: void };

// VTID-04831 — a rejected password sign-in names its reason. Specs sign in
// through the `request` fixture and only assert that a token came back, so a
// rejection read as a bare "sign-in failed". Log the HTTP status and Supabase's
// own error code/message from the response — never the request (email,
// password) and never a token, and redact anything email-shaped in the message.
export function describeAuthRejection(status: number, body: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof b[k] === 'string' || typeof b[k] === 'number' ? String(b[k]) : '');
  const code = pick('error_code') || pick('error') || pick('code');
  const msg = (pick('msg') || pick('error_description') || pick('message'))
    .replace(/[^\s@]+@[^\s@]+/g, '<redacted>')
    .slice(0, 200);
  return `[staging-guard] sign-in rejected: HTTP ${status}${code ? ` ${code}` : ''}${msg ? ` — ${msg}` : ''}`;
}

const SIGN_IN = /\/auth\/v1\/token\?grant_type=password/;

export const test = base.extend<GuardOptions & GuardFixtures>({
  allowAbortedWrites: [null, { option: true }],
  request: async ({ request }, use, testInfo) => {
    const post = request.post.bind(request);
    request.post = async (url: string, options?: Parameters<typeof post>[1]) => {
      const res = await post(url, options);
      if (SIGN_IN.test(url) && !res.ok()) {
        const line = describeAuthRejection(res.status(), await res.json().catch(() => null));
        console.log(line);
        await testInfo.attach('sign-in-rejected', { body: line, contentType: 'text/plain' });
      }
      return res;
    };
    await use(request);
  },
  stagingGuard: [
    async ({ page, allowAbortedWrites }, use, testInfo) => {
      const blocked: string[] = [];
      await page.route('**/*', (route) => {
        const req = route.request();
        const method = req.method().toUpperCase();
        const url = req.url();
        let host = '';
        try {
          host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
        } catch {
          return route.continue();
        }
        if (PRODUCTION_HOST.test(host)) {
          blocked.push(`${method} ${url} (production host)`);
          return route.abort('blockedbyclient');
        }
        if (!GUARDED_HOST.test(host) || READ_METHODS.has(method)) return route.continue();
        if (ALWAYS_ALLOWED_WRITES.some((r) => r.test(url))) return route.continue();
        blocked.push(`${method} ${url}`);
        return route.abort('blockedbyclient');
      });
      await use();
      if (blocked.length) {
        await testInfo.attach('staging-guard-blocked', { body: blocked.join('\n'), contentType: 'text/plain' });
      }
      const allow: RegExp[] =
        allowAbortedWrites == null ? [] : Array.isArray(allowAbortedWrites) ? allowAbortedWrites : [allowAbortedWrites];
      const unexpected = blocked.filter((b) => !DEFAULT_ALLOWED_ABORTS.some((r) => r.test(b)) && !allow.some((r) => r.test(b)));
      if (unexpected.length) {
        throw new Error(
          `staging-guard aborted ${unexpected.length} request(s) — staging writes reach production data, and a staging build must not call production:\n  ${unexpected.join('\n  ')}`,
        );
      }
    },
    { auto: true },
  ],
});

export { expect };
