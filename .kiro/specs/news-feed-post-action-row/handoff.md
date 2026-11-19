---
slug: news-feed-post-action-row
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: jtadic
updated: 2026-11-19T13:20Z
depends_on_plans: [preview-gateway-recovery]
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — News Feed post card: author row on top, actions on their own row
Owner request 2026-11-19 (Kiro Web, phone screenshot): the like, comment and send controls look crowded and sit too
close to the author on News Feed post cards; continue what the earlier Claude Code session started (VTID-05795,
exafyltd/vitana-v1#1685, which merged the actions on the author line). Plan block: `plan.md`. Lane:
`lanes/card-actions.md` (one lane, one source file and its test in vitana-v1).

## Log
### 2026-11-19T12:10Z · kiro-jtadic-202611191143-e223 · created → drafted
Holder of the `news-feed-post-action-row/_plan` claim. Read `CommunityPostCard.tsx` and its test on vitana-v1
origin/main bbe90b713 and the history of #1685. Prototyped the layout locally (mocked hooks, no live data) and
measured it at 390×844. No VTID allocated, no live system touched.
Next: PLAN-SPAR spars the `plan(news-feed-post-action-row)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTID into the lane; seat `jtadic` builds `card-actions`.

### 2026-11-19T13:20Z · kiro-jtadic-202611191143-e223 · drafted (blocked on preview-gateway-recovery)
**Resume record (lane `card-actions`, vitana-v1).** Branch `kiro/news-feed-post-action-row/card-actions`, local
commit `cad441c1747cd1c6208045ef226b396fa976a30b` on base vitana-v1 `origin/main` bbe90b713. Not pushed: the push
guard's preflight refuses it until this plan is on `main` (Lane scope: lane file not found; Collab handoff). The
commit is kept as `artifacts/card-actions.patch` (`git am` it on a branch from bbe90b713 or later). Results:
`artifacts/test-results.txt` (22/22 file, 42/42 `src/components/home`, new case red on base, build exit 0);
`artifacts/harness-interactions.txt` (heart, comment, send, Likes link, ⋮ work on phone, desktop and RTL in a
local harness); screenshots in `artifacts/screenshots/` (before/after at 390x844 and 1400x900, each interaction).
Draft read-only staging spec: `artifacts/staging-spec.draft.ts.txt` (becomes
`tests/e2e/staging/vtid-<VTID>-news-feed-post-action-row.staging.spec.ts`; it never clicks heart, send or a menu item).

**PLAN-SPAR 401 (run 44519026299), read-only evidence.** Endpoint `https://preview-aws-gateway.vitanaland.com`
(run env `GATEWAY_URL`), token reference `secrets.GATEWAY_SERVICE_TOKEN` (PLAN-SPAR.yml:93 at base 79a84a31b5, value
masked), `PLAN_SPAR_ALLOCATE: true`. ALB rule 9 (host preview-aws-gateway + `/api/v1/*`) sends the call to
`vitana-tg-gateway-preview`; `vitana-gateway-preview` runs 1/1 on `:2`, whose secrets are PLAN_SPARRING_GITHUB_TOKEN,
DEEPSEEK_API_KEY, GATEWAY_INTERNAL_TOKEN, SUPABASE_JWT_SECRET, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE: no
`GATEWAY_SERVICE_TOKEN`, so `matchesServiceToken` (require-service-or-admin.ts) rejects every token with 401. Staging
`vitana-gateway` is 0/0 on `:1025`. (This corrects the first diagnosis in the #5120 comment of 11:59Z, which blamed
fca0186b32.) Covered by KIRO 12's plan `preview-gateway-recovery` (branch `kiro-plan-r2/preview-gateway-recovery`,
session kiro-jtadic-202611191115-a88f): preview sparring token (§2, checklist steps 4 and 8), lane `plan-spar-token`
(step 9), IAM operator per its §7b. No new credential request from this plan.

**After recovery.** Preview sparring runs with allocation off (that plan's D2), so a converged #5120 gets no VTID from
CI. The owner instructed (2026-11-19): obtain the News Feed VTID under rule 55 through the authorized registry
operator (rule 55: the owner allocates through the exemption role). Then: push the lane, open the vitana-v1 PR,
reviewer agent, §7b merge, ordinary staging deploy (AWS-STAGE-DEPLOY-FRONTEND), STAGING-VERIFY community-app.
