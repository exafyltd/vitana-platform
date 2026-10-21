# Plan sparring record — VTID-04897 (shared with VTID-04896, VTID-04898)

Plan hash (sha256 of the text between the plan markers): `2c81be42f5b5cfe29be90bae78815e6cd44cf0631b1733c1d195b70093452664`. Partner: plan-sparring-partner, 2 rounds, CONVERGED. Owner approved in session 2026-10-05 ("Approved").

# Plan: first gateway production release with the VTNA reward sweep off, Commerce MCP on in production, and the landing orb overlap fix

Planner: Claude Code session (owner: d.stevanovic@exafy.io). Date: 2026-10-05.

<!-- plan:begin -->
## Context (owner instructions, 2026-10-05)
- Resolve the production AWS OIDC/IAM trust failure for the gateway deploy workflow.
- First gateway production deploy: the VTNA reward sweep must be off (`REWARD_SWEEP_ENABLED=false`) unless the owner explicitly approves enabling it; confirm the exact production setting before deploying.
- After the gateway production deploy is possible and verified, enable and verify Commerce MCP in production, before any frontend production deploy.
- Fix the desktop pre-login Commerce landing, where the floating Vitana Orb overlaps the "one-step" MCP heading; re-run the frontend verification.
- Do not create/publish Partner Terms v1, do not record acceptances, no frontend production deploy (owner approval later).

## Findings that shape the plan
- AWS "OIDC failure": of today's two failed `AWS-PROD-DEPLOY-GATEWAY.yml` runs, run 37297470277 (10:34) was dispatched from a feature branch (`claude/vitana-navigation-rebuild-6vy46r`); the prod role trusts `main` only, so `AssumeRoleWithWebIdentity` was correctly refused. Run 37291205723 (09:36, `main`) failed earlier, at "Resolve deploy source": staging was mid-deploy (serving 7ad4276c, task def 643b65bc). The same `AWS_PROD_ROLE_ARN` authenticates fine from `main` today (CODEINTEL-INDEX 12:15, TEST-CATALOG 11:58). Conclusion: no AWS change is needed; the fix is procedural — dispatch from `main` while staging is stable, with `expected_commit`. No code change for this item.
- Reward sweep gate (`services/gateway/src/services/rewards/reward-sweep.ts`): allowed unless `VITANA_ENV=staging` or `REWARD_SWEEP_ENABLED === 'false'`; the in-process loop additionally needs ECS. Production sets neither today, so promoting c1b92d0e would start the 6-hourly paying loop at boot.
- Production env is assembled by jq steps in `AWS-PROD-DEPLOY-GATEWAY.yml` on top of the live task definition; `env_overrides` (JSON) is applied last in step "2/2"; step 2/2's run block is near GitHub's 20,000-char limit, so new pins go in their own small steps (precedent: "Build task-definition (internal token)", VTID-04677).
- `scripts/conversation/generate-flag-pins.mjs` extracts every `{name:"X", value:"Y"}` from both gateway deploy workflows into `conversation-flag-pins.generated.ts`; a jest test fails when it is stale. `COMMERCE_MCP_ENABLED` is registered there as `{ staging: "true", prod: null }`.
- Commerce MCP in production needs only `COMMERCE_MCP_ENABLED=true`: resource origin comes from the request host (`gateway.vitanaland.com`), the authorization server is `${SUPABASE_URL}/auth/v1` (same project as staging), portal links map `gateway.` → `vitanaland.com`, and the OAuth consent page `/oauth/consent` is already in the production frontend (VTID-04848, 2026-10-02; production frontend 5ad74d0 contains it).
- Orb overlap: the orb FAB (`.vtorb-fab`, injected by the gateway widget) is positioned by `src/index.css` at desktop widths `left: 8rem; bottom: 1.25rem; translateX(-50%)` — the sidebar-footer spot. The guest Commerce page has no sidebar, so at 1400×900 the FAB — measured on staging with Playwright: 64×64 at desktop, 56×56 at 390px (`getBoundingClientRect`), x 96–160, y 816–880 — sits on the one-step heading at first paint, and over content in that band while scrolling. Precedent for a per-page orb placement: `body.maxina-intro-page` (IntroExperience.tsx adds/removes the body class; index.css overrides).

## Work items (three VTIDs, three PRs, in this order)

### A. Gateway prod: reward sweep pinned off (vitana-platform, own VTID)
1. New step in `AWS-PROD-DEPLOY-GATEWAY.yml`, after "internal token" and before "2/2": `Build task-definition (reward sweep off)` — upsert `{name:"REWARD_SWEEP_ENABLED", value:"false"}` into the container environment and echo the resulting value. Comment: the owner's 2026-10-05 decision; enabling is a separate explicit approval, done with `env_overrides={"REWARD_SWEEP_ENABLED":"true"}` on a dispatch (applied later in 2/2) or by changing this pin.
2. New read-only step after "Smoke": `Verify reward sweep setting (live task definition)` — `aws ecs describe-services` → task definition → `REWARD_SWEEP_ENABLED`; expected `false` unless `env_overrides` names the key, in which case the expected value is that override. Mismatch fails the job, which triggers the existing automatic rollback (VTID-04647).
3. Regenerate `conversation-flag-pins.generated.ts` with the generator (pure node, no deps); `--check` passes.
4. Tests: extend the existing workflow test (`test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts` covers bash/size) with a new jest test `test/vtid-XXXXX-prod-reward-sweep-pin.test.ts` asserting the prod workflow pins `REWARD_SWEEP_ENABLED` to `"false"`, the verify step exists after Smoke and before rollback, and the staging workflow does not set it (staging is already excluded by `VITANA_ENV`). Change suite `docs/validation/<VTID>/staging-tests.json` = that jest file (existing kind).
5. Merge (no gateway source change → no staging redeploy; staging keeps serving c1b92d0e).
6. Before dispatch: confirm to the owner the exact setting that will ship (`REWARD_SWEEP_ENABLED=false`, no override), the commit range `ce860e66..c1b92d0e` (13 commits, all listed in the go/no-go report), and that staging serves c1b92d0e with STAGING-VERIFY passed (run 37309290008).
7. Dispatch from `main`: `deploy_mode=promote-staging`, `expected_commit=c1b92d0e325c9196707c428089ce26c08978199b`, reason naming the VTID. No `env_overrides`.
8. Verify (all read-only GETs, no sign-in): the workflow's own Smoke + Post-deploy + new sweep check; `build-info` git_commit = c1b92d0e; `/alive` 200; partner-terms routes answer 401 JSON (route mounted); `partner_terms_versions` still 0 rows / acceptances 0 (read-only SQL); production stays on the old MCP state (metadata 404) until item B.

### B. Commerce MCP on in production (vitana-platform, own VTID; only after A is verified)
0. Ordering guard: B's PR is branched from `main` after A's PR is merged, and before dispatch I confirm the workflow file on `main` contains A's `Build task-definition (reward sweep off)` step and its post-deploy check. (Even without it, env-only re-registers the live task definition, which after A carries `REWARD_SWEEP_ENABLED=false`; the pin step re-applies it explicitly.)
1. New small step `Build task-definition (Commerce MCP)` in the prod workflow pinning `{name:"COMMERCE_MCP_ENABLED", value:"true"}`; rollback = "false". Regenerate the flag pins (prod becomes "true").
2. Test: jest asserts the pin and the regenerated file. Functional coverage of the MCP route is the existing CI suite `services/gateway/test/commerce-mcp.test.ts` (21 tests: metadata, 401 challenge, scopes, token checks, tools); the change suite lists it alongside the new pin test, so STAGING-VERIFY runs both. The production check stays read-only; a real connection is the owner's check.
3. Merge, then dispatch `deploy_mode=env-only` (keeps the image A shipped, re-applies all pins incl. the sweep-off pin), reason naming the VTID.
4. Verify read-only: `GET https://gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp` → 200 JSON, `resource` = `https://gateway.vitanaland.com/mcp`, `authorization_servers` = the Supabase auth issuer, `scopes_supported` = ["email","profile"]; unauthenticated `GET/POST /mcp` → 401 with `WWW-Authenticate` naming the metadata URL and `scope="email profile"` (a POST without a token is refused by auth before any handler; no data written); Supabase `/.well-known/oauth-authorization-server/auth/v1` → 200 with registration/authorization endpoints; build-info unchanged (c1b92d0e); sweep still `false`. Not done by me: a real assistant connection (it registers an OAuth client and signs in — a write); offered to the owner as the final human check.

### C. Landing orb overlap (vitana-v1, own VTID)
1. `CommerceGuestLanding.tsx`: on mount add `commerce-guest-page` to `<body>`, remove on unmount (IntroExperience pattern).
2. `src/index.css`, `@media (min-width: 1024px)` only: `body.commerce-guest-page` docks the orb in the bottom-left corner of the page gutter (`left: 3rem; bottom: 1.25rem`, same transform), and reserves that gutter on both sides of the page content: `CommerceShell.tsx` gets `data-commerce-main` on its `<main>`, and the rule targets `body.commerce-guest-page main[data-commerce-main] { padding-inline: 6rem }` — not bare `main`, and not only the landing div, because the guest hero (rendered by CommercePortal above the landing) must clear the orb too. Symmetric, so the column stays centred and LTR/RTL look the same. Geometry: orb centre 48px, 64px wide → occupies 16–80px; content starts at ≥96px at every width ≥1024px; at 1024px the content column is 832px (the 3-card and 4-step grids still fit; checked in the screenshots). Mobile/tablet (<1024px) unchanged.
3. Tests: vitest pins (body class added/removed; the CSS rule exists inside the ≥1024px media query); staging Playwright spec `tests/e2e/staging/vtid-XXXXX-commerce-guest-orb.staging.spec.ts`, read-only, signed out, at 1024×768, 1280×800, 1400×900 and 1920×1080: the orb button is visible and its box lies entirely left of the landing's content box (`commerce-guest-landing` and the hero `h1`), so no scroll position can put it over landing text; and the one-step heading's box does not intersect the orb box at first paint. Change suite = the vitest file + that spec + the existing VTID-04894 spec.
4. Screenshots (desktop 1400×900 and mobile 390×844) before/after, attached to the PR.
5. Merge → staging deploy → STAGING-VERIFY community-app must pass; report. No frontend production deploy.

## Out of scope
Partner Terms v1 (no create/publish), acceptances, frontend production deploy, `SCHEDULED_NOTIFICATIONS_AUTH_MODE`, enabling the reward sweep, any AWS IAM change.

## Change class
standard (touches `.github/workflows` deploy files and a production deploy).

## Scope
vitana-platform: `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml`, `services/gateway/src/services/conversation/conversation-flag-pins.generated.ts`, new jest tests, `docs/validation/<VTID>/`. vitana-v1: `src/components/commerce/CommerceGuestLanding.tsx`, `src/index.css`, new vitest + staging spec, `docs/validation/<VTID>/`. Production: one promote-staging gateway deploy (A), one env-only gateway deploy (B).
<!-- plan:end -->


## Planner responses — round 1
- F1 [major] ACCEPTED — added B step 0: B is branched after A merges, and the workflow on `main` is checked for A's step and post-deploy check before B's dispatch.
- F2 [minor] ACCEPTED — the size and position come from a Playwright measurement on staging (`getBoundingClientRect` of `.vtorb-fab`: 64×64 at 1400×900, 56×56 at 390×844); the staging spec asserts boxes, not constants.
- F3 [minor] ACCEPTED (modified) — the rule targets the Commerce shell's own `<main data-commerce-main>` instead of bare `main`. Not the landing div alone: the guest hero sits outside it (CommercePortal) and must clear the orb as well. The body class lives only while the guest landing is mounted (IntroExperience cleanup pattern), and CommerceShell is the only `<main>` on that page.
- F4 [minor] ACKNOWLEDGED — kept as a regression guard; no plan change.
- F5 [minor] ACKNOWLEDGED — the fix adds no visible text; no plan change.
- F6 [major] ACCEPTED — `services/gateway/test/commerce-mcp.test.ts` (21 tests) is named as the functional coverage and added to B's change suite.
- Q1: STAGING-VERIFY run 37309290008 completed and passed 67/67 on c1b92d0e. The 13 commits in ce860e66..c1b92d0e were all listed commit-by-commit in the go/no-go report the owner reviewed; the owner then directed this first production deploy with the sweep off. I restate the range for the owner before dispatch (A step 6).
- Q2: 3rem is derived, not a design spec: centre 48px with a 64px orb → 16–80px, leaving 16px to the viewport edge and 16px to the 96px content gutter.
- Q3: at 1024px the column becomes 832px; the why-grid (3 cards) and the 4-step flow fit at that width; the 1024×768 screenshot and spec cover it. Symmetric padding keeps the page centred.

## Round 2 — partner status
F1 closed · F2 closed · F3 closed · F4 acknowledged · F5 acknowledged · F6 closed. No new blocker or major. Questions: none.

## Verdict
CONVERGED after 2 rounds (standard class, cap 3). Awaiting owner approval.
