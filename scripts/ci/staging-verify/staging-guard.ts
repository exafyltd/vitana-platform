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
// expected (a telemetry beacon, say) via
//
//   test.use({ allowAbortedWrites: [/\/rest\/v1\/rpc\/touch_presence/] });

import { test as base, expect } from '@playwright/test';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Where data lives: every gateway (staging, production, DR) and Supabase.
const GUARDED_HOST = /(^|\.)supabase\.co$|gateway\.vitanaland\.com$/;
// Mirror of PRODUCTION_HOSTS in lib.cjs.
const PRODUCTION_HOST = /^(vitanaland\.com|www\.vitanaland\.com|gateway\.vitanaland\.com|dr-app\.vitanaland\.com|dr-gateway\.vitanaland\.com)$/;
const ALWAYS_ALLOWED_WRITES = [/\/auth\/v1\/token(\?|$)/];

type GuardOptions = { allowAbortedWrites: RegExp[] };
type GuardFixtures = { stagingGuard: void };

export const test = base.extend<GuardOptions & GuardFixtures>({
  allowAbortedWrites: [[], { option: true }],
  stagingGuard: [
    async ({ page, allowAbortedWrites }, use, testInfo) => {
      const blocked: string[] = [];
      await page.route('**/*', (route) => {
        const req = route.request();
        const method = req.method().toUpperCase();
        const url = req.url();
        let host = '';
        try {
          host = new URL(url).host;
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
      const unexpected = blocked.filter((b) => !allowAbortedWrites.some((r) => r.test(b)));
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
