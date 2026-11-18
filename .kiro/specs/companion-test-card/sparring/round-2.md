# Sparring round 2 — converged

Session: `97e421c8-09eb-4d71-94b8-bb09b5d32ff1` · plan hash `70f1f7ce49198ee4cd26e574e2c0b96978b1dd25e4fc773c248cac7fef53969b`

## Summary

All three R1 findings were accepted and the revised plan addresses each one. I verified the corrections in the plan text. One new minor finding: the plan references `getServiceClient()` as the function to use, but this is a local (non-exported) function inside `scheduled-notifications.ts` and cannot be imported from `companion.ts`. Meanwhile, the already-imported `getSupabase()` is itself a service-role client, so the RLS concern from R1-F1 is satisfied either way. No blockers or major issues found.

## Findings

### R2-F1 [minor]

The plan says the test-card route must use `getServiceClient()` (referencing `scheduled-notifications.ts:1766`) and 'never getSupabase()'. However, `getServiceClient()` is a local, non-exported function defined inside `scheduled-notifications.ts` (lines 68-74) and cannot be imported from `companion.ts`. Meanwhile, `getSupabase()` from `lib/supabase.ts` already creates a service-role client using `SUPABASE_SERVICE_ROLE_KEY || SUPABASE_SERVICE_ROLE` (lines 9, 19) — it is not an anon-key client. Both functions produce equivalent service-role clients that bypass RLS. The plan should either reference `getSupabase()` (already imported in companion.ts:22), extract the helper to a shared location, or note that a new helper is needed.

- `exafyltd/vitana-platform:services/gateway/src/routes/scheduled-notifications.ts:67` — // ── Helper: get service-role Supabase client ─────────────────
async function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}
- `exafyltd/vitana-platform:services/gateway/src/lib/supabase.ts:5` — export const getSupabase = (): SupabaseClient | null => {
  if (supabaseInstance) return supabaseInstance;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error(
      '[Supabase] Configuration missing: SUPABASE_URL or SUPABASE_SERVICE_ROLE not set. ' +
      'Governance features will be unavailable.'
    );
    return null;
  }

  supabaseInstance = createClient(supabaseUrl, supabaseKey);
  return supabaseInstance;
};
- `exafyltd/vitana-platform:services/gateway/src/routes/companion.ts:22` — import { getSupabase } from '../lib/supabase';

Suggestion: Simplify: the test-card route can use the already-imported `getSupabase()` from `lib/supabase.ts`, which is already a service-role client. Or if a separate instance is desired, extract the helper to a shared module. Either way, note that `getServiceClient()` is local to `scheduled-notifications.ts` and not importable.
