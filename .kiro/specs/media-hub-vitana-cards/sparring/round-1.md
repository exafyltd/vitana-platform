# Sparring round 1 — in_progress

Session: `d15d710a-bc33-4d99-a35d-99bdcde31d8e` · plan hash `8e06289d0a713e3aabc28f51b11447f0f4bbded0728938d102d8eb89269a7910`

## Summary

The plan's premises cannot be verified because all code references target `vitana-v1` (commit `6b9137ac5`), but the review session is pinned to `vitana-platform@814b585`. The `vitana-v1` repo has no pinned ref, so every `read_file` against it fails. Additionally, approximate searches for `EnrichmentCardStrip` and `MediaHub` in `vitana-v1` returned zero hits, casting doubt on the premises themselves. The staging spec infrastructure (`staging-guard`, the `e2e/staging/` directory) lives in `vitana-platform`, not `vitana-v1`, and the plan's stated path pattern for staging specs does not match the actual location.

## Findings

### R1-F1 [blocker]

All five code premises reference vitana-v1 files (src/pages/community/MediaHub.tsx, src/components/media/spotlight/MediaHubSpotlight.tsx, src/components/media/**) but none can be verified. The vitana-v1 repo is not pinned in this review session, and approximate search on vitana-v1's default branch returns zero hits for both 'EnrichmentCardStrip' and 'MediaHub'. Either the file paths are wrong, the component does not exist (yet or any more), or the search index is stale — but in any case the plan's premises are unverifiable and the claimed line numbers (line 2 import, lines 874-875 mount) cannot be confirmed.

- `exafyltd/vitana-platform:AGENTS.md:1` — Strict rule: Codex may only work with these GitHub repositories:
- `exafyltd/vitana-v1`
- `exafyltd/vitana-platform`
- `exafyltd/vitana-platform:docs/validation/VTID-05085/plan-sparring.md:15` — **Scope:** `vitana-v1` (/home/user/vitana-v1 — frontend components, hooks, screens), `vitana-platform` (/home/user/vitana-platform — gateway endpoint, migration, feature-tips, completion resolver)

Suggestion: Pin the vitana-v1 repo in the review session so premises can be checked, OR re-state every premise with verifiable evidence (e.g. include the file contents / git-show output in the plan itself). Without verification, the plan cannot be approved.

### R1-F2 [major]

The plan says the staging spec pattern is at 'tests/e2e/staging/vtid-05330-profile-posts-full-width.staging.spec.ts' and the new spec will be created at 'tests/e2e/staging/media-hub-vitana-cards.staging.spec.ts'. But in vitana-platform, all existing staging specs live at 'e2e/staging/' (not 'tests/e2e/staging/'), and staging-guard exists only in vitana-platform (search in vitana-v1 returned zero hits). The plan would create the spec at a non-existent path in the wrong directory structure, and it is unclear which repo the spec belongs to.

- `exafyltd/vitana-platform:e2e/staging/vtid-05030-connection-tokens.staging.spec.ts:14` — import { test, expect } from './staging-guard';
- `exafyltd/vitana-platform:e2e/staging/vtid-04842-commerce-ai-setup-on.staging.spec.ts` — (file exists at e2e/staging/, not tests/e2e/staging/)

Suggestion: Correct the staging spec path to 'e2e/staging/' in vitana-platform, matching the existing convention. Confirm the spec will import staging-guard from the correct relative path. If the spec is meant for vitana-v1, explain how staging-guard and the Playwright runner will be available there.

### R1-F3 [major]

The plan's staging spec uses browser viewports (390×844 phone, 1400×900 desktop) to check for DOM elements (data-testid, text content), implying a Playwright browser-context test. However, all existing staging specs in vitana-platform/e2e/staging/ use API-level requests (request.get/request.post via the Playwright APIRequestContext), not browser pages. The plan does not explain how the browser-based pattern will work with the existing staging-guard and Playwright config, which may not be set up for browser tests.

- `exafyltd/vitana-platform:e2e/staging/vtid-05030-connection-tokens.staging.spec.ts:18` — test('signed-in wearables providers and connections still serve, with no token fields', async ({ request }) => {
    test.setTimeout(120_000);
    const email = process.env.TEST_USER_EMAIL ?? '';
    const password = process.env.TEST_USER_PASSWORD ?? '';
    // Not a skip: a skipped check passes silently.
    expect(email && password, 'TEST_USER_EMAIL / TEST_USER_PASSWORD not provided').toBeTruthy();
    const gateway = process.env.STAGING_GATEWAY_URL ?? '';
    const frontend = process.env.STAGING_FRONTEND_URL ?? '';
    expect(gateway, 'STAGING_GATEWAY_URL').toBeTruthy();

Suggestion: Clarify whether the staging spec will use a browser context (page) or API requests. If browser-based, confirm the Playwright config supports browser tests for staging, or describe the config changes needed. If API-based, revise the spec design (viewport assertions don't apply to API requests).

### R1-F4 [minor]

The plan does not specify which repo each change lands in. Changes 1 (delete lines in MediaHub.tsx) and 3 (docs/validation/) could be in different repos. The VTID-05085 plan-sparring doc confirms the Unified Card System spans both vitana-v1 (frontend) and vitana-platform (gateway, docs). This removal plan needs to state explicitly: Change 1 → vitana-v1, Change 2 → vitana-platform (or vitana-v1 if a staging runner exists there), Change 3 → vitana-platform.

- `exafyltd/vitana-platform:docs/validation/VTID-05085/plan-sparring.md:15` — **Scope:** `vitana-v1` (/home/user/vitana-v1 — frontend components, hooks, screens), `vitana-platform` (/home/user/vitana-platform — gateway endpoint, migration, feature-tips, completion resolver)

Suggestion: Add an explicit repo annotation to each change (e.g. 'Change 1 (vitana-v1): ...', 'Change 2 (vitana-platform): ...').

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
