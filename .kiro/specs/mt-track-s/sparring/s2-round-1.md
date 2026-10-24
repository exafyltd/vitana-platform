# Sparring round 1 — in_progress

Session: `d0c274cd-a9f0-48dd-a0a1-ea6061a344b6` · plan hash `811cf34df6b8910809d95ca1ee99c6090075ce391f34934766f124e319e09721`

## Summary

The plan correctly records 16 closed Track S / WS10 items and focuses the single open lane on vitana-v1 (removing the dead linkedin-import edge function, adding an inventory gate script, and updating the s4 test). Platform-side CLOSED premises (S-A, S-C, S-D, S-F, S-G, S-K, S-L, WS10 webhooks/tokens) all check out against the pinned commit. Three issues require attention: (1) the entire implementation is in vitana-v1, which has no pinned ref in this session, leaving all implementation-side premises unverifiable; (2) the S-E CLOSED description over-claims its security conditions — the actual migration only checks `open_signup`, not `is_active` or `NOT is_platform` as stated; (3) `/debug/memory` and `/debug/intent` carry no `requireAuth` middleware — they are fully anonymous in a dev-sandbox environment, which the plan's "dev-sandbox-gated" language under-represents.

## Findings

### R1-F1 [blocker]

All of the plan's actual code changes live in exafyltd/vitana-v1, but that repo has no pinned ref in this review session, making every vitana-v1 premise unverifiable with read_file. The plan lists at least nine verifiable vitana-v1 facts: (a) supabase/functions/linkedin-import/index.ts exists with the VTID-05049 removal comment at lines 5-7; (b) supabase/config.toml has [functions.linkedin-import] at line 72; (c) vitest.config.ts include is 'src/**/*.test.{ts,tsx}' at line 19; (d) package.json test chain at line 29; (e) src/lib/edge-functions-caller-identity.s4.test.ts has linkedin-import assertions at four specific locations (:77-88, :90-92, :107-110, :272); (f) scripts/check-edge-data-client.mjs and check-realtime-helper.mjs exist; (g) no app code calls functions.invoke('linkedin-import'); (h) SUPABASE-FUNCTIONS-RETIRE.yml ALLOWLIST mechanism; (i) social-media-import replaced linkedin-import. None of these can be confirmed from the pinned commit. If any premise is wrong — e.g., the s4 test file has fewer or different linkedin-import references than the four spots cited, or vitest.config.ts actually collects supabase/functions — the lane will either break CI or silently omit required test updates.

- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:15553` — // VTID-05040: exafy_admin only — the response carries the member's memory and full context.
router.get('/debug/context-bootstrap', requireAuth, requireExafyAdmin, async (req: Request, res: Response) => {

Suggestion: Pin exafyltd/vitana-v1 to a commit in this sparring session and re-verify all nine vitana-v1 premises listed above with read_file before the plan is accepted. At minimum: (a) confirm the exact four line numbers in the s4 test that reference linkedin-import; (b) confirm vitest.config.ts include glob; (c) confirm package.json test chain includes the two existing check-* scripts; (d) grep both repos for functions.invoke('linkedin-import') to confirm no live callers.

### R1-F2 [major]

The plan's closure record for S-E states the fix restricts self-enrollment to tenants matching 'open_signup AND is_active AND NOT is_platform'. The actual migration 20261010180200 only checks open_signup. The SELECT that populates tenant_record fetches only tenant_id and open_signup with no is_active or NOT is_platform filter, and the sole admission branch is 'ELSIF tenant_record.open_signup THEN'. There is no is_active or NOT is_platform guard anywhere in the function body. If any platform or inactive tenant is ever granted open_signup = true (e.g., by an admin data-fix), any authenticated user can self-enroll into it. The plan's stated closure condition is therefore factually inaccurate, and successor plans will rely on this documented state as proven.

- `exafyltd/vitana-platform:supabase/migrations/20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql:57` — SELECT t.tenant_id, t.open_signup INTO tenant_record
  FROM public.tenants t
 WHERE t.slug = p_tenant_slug;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant not found: %', p_tenant_slug;
  END IF;

  v_is_member := EXISTS ( ... );
  ...
  IF v_is_member OR v_is_exafy THEN
    NULL; -- switch only
  ELSIF tenant_record.open_signup THEN
    INSERT INTO public.memberships ...
- `exafyltd/vitana-platform:supabase/migrations/20261010180000_vtid_05043_s3_membership_side_effect_guard.sql:73` — ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS open_signup boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenants.open_signup IS
  'VTID-05043: a signed-in user may join this tenant by themselves (switch_to_tenant_by_slug). '
  'false = membership only through an admin or an invitation.';

Suggestion: Either (a) amend the S-E closure record to accurately state only 'open_signup' is the live guard, and separately track adding is_active and NOT is_platform checks as an open residual; or (b) add those two conditions to the WHERE clause of the switch_to_tenant_by_slug SELECT (or as explicit ELSIF guards after the FOUND check) within this or a follow-on lane. The safer long-term fix is to add AND is_active = true AND is_platform = false to the SELECT so the function cannot be invoked against inactive or platform tenants regardless of their open_signup flag.

### R1-F3 [minor]

The plan describes /debug/memory and /debug/intent as 'dev-sandbox-gated', implying they are protected. In fact both routes carry no requireAuth middleware at all — they are fully anonymous in any environment. In a dev-sandbox they expose live ORB memory snapshots and intent-engine internals to any unauthenticated caller. The plan defers the route inventory to WS0 (M0), but calling these routes 'gated' over-states their security posture and may cause successor plans to skip re-examining them.

- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:15332` — router.get('/debug/memory', async (_req: Request, res: Response) => {
  // Dev-sandbox gate: return 404 in non-dev environments
  if (!isDevSandbox()) {
    console.log('[VTID-01107] Debug endpoint accessed in non-dev environment, returning 404');
    return res.status(404).json({
      ok: false,
      error: 'Not found'
    });
  }
- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:15421` — router.get('/debug/intent', async (req: Request, res: Response) => {
  // Dev-sandbox gate: return 404 in non-dev environments
  if (!isDevSandbox()) {
    console.log('[VTID-01113] Debug intent endpoint accessed in non-dev environment, returning 404');
    return res.status(404).json({
      ok: false,
      error: 'Not found'
    });
  }

Suggestion: In the S-J CLOSED record, replace 'dev-sandbox-gated' with 'dev-sandbox-only (anonymous — no requireAuth)' so the characterisation is accurate. Add a WS0 backlog note that both routes should receive at minimum requireAuth before any environment promotes them. This is not a required change for this lane but the documentation should not misrepresent the existing posture.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
