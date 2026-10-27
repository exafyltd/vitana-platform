---
change_class: standard
---
# plan(quality-checks): proportional quality checks for planning, building, reviewing and verifying
Author: Kiro, seat `jtadic`, session `kiro-jtadic-202610271220-68a5` (Kiro Web). Repos: `exafyltd/vitana-platform`
and `exafyltd/vitana-v1`. Premises pinned to vitana-platform `origin/main` `4ace427c0d` and vitana-v1 `origin/main`
`57aece53f`. Detail per lane: `tasks.md`; lane files under `lanes/`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-27 (Kiro Web): *"Review a representative sample of recently completed tasks, PRs, bug reports, and
staging verification results to identify recurring quality problems … Identify the root causes and propose practical
improvements to how Kiro understands, implements, reviews, and verifies tasks. Recommend checks that are proportional
to the type of change: UI, backend, database, integrations, or infrastructure. Implement independent improvements that
have clear evidence and do not conflict with ongoing work. Do not edit the Kiro session setup, hooks, guards, or
preflight currently being changed in another session."*

## 2. Today (evidence, 2026-09-27 → 2026-10-27)
Sample: 287 merged vitana-v1 PRs, 401 substantive vitana-platform commits, 587 STAGING-VERIFY runs, 45 reviewer-agent
entries, 8 sampled specs.
- **Phone code paths missed.** v1 #1340 → #1344 (phone `/settings/privacy` redirects to `MobileSettings`, which never
  rendered the card); #1358 → #1359 (an `opacity-0` hover toolbar caught taps on phones); #1374–#1382 → #1399
  (Spotlight framed phones); #1490 (owner: phone Matches list does not scroll to its last card).
- **Edge cases / races missed.** #1429 → #1432 (late suggestion overwrote typed input); #1430 → #1433/#1434/#1436
  (late-loading content, 3 fix-forwards); #1268 → #1269 (empty day lost its summary); #1329 → #1330 (clipping).
- **Contract checked after the probe was written.** platform VTID-05065 and VTID-05069 (SSE 401/403 sent as
  `text/event-stream`), VTID-05098/05129/05018/04895 (staging probe expected the wrong status), #4159/#4164 → #4194
  (anonymous 200 expected on a `requireServiceOrAdmin` route). Same-day fix-forward each time.
- **Migration dropped a live default.** #4114 → #4118 (`health_compute_vitana_index(date)` DEFAULT).
- **Workflow and infra assumptions.** #4266 → #4351 (`secrets.` in a step `if:` made `PLAN-SPAR.yml` invalid; sparring
  down 10-22 → 10-26); VTID-04849 → 04858 → 04930 (a dead secret removed from one task definition at a time).
- **Tests that pin volatile text or locations.** #4182 → #4223/#4225 → #4258 → #4374 (a moved function, a stale
  `staging-tests.json`, a cache-key pin); `VTID-04661/staging-tests.json` rewritten 27 times for `app.js?v=` pins.
- **Staging specs fail on their first run.** At least 13 v1 test-only fix chains (#1431 duplicate `const`; #1259–#1265
  aborted POSTs, ORB overlay, `force` click on `aria-disabled`; #1440 a `#root > *` `.first()` wait that can never
  pass). Eight v1 commits only removed a UTF-8 BOM from `staging-tests.json` (e.g. `36d702bfd`: "The canonical
  STAGING-VERIFY validator rejected the manifest as invalid JSON because PowerShell wrote a UTF-8 BOM");
  `scripts/ci/staging-verify/run.mjs:203-210` `loadManifest` calls `JSON.parse` on the raw text.
- **Staging proof that does not prove the change.** 66 of 193 new v1 manifests are Vitest `existing` only; VTID-05332's
  asserts a class string (jsdom has no layout); platform VTID-05220's checks `/alive` + 401, not `PM_MODE=live`.
- **Done before verified.** VTID-05013 reached production and was rolled back (#1301 → #1302/#1303); #1440 says the
  Spotlight batches were in production while their suites were red; #4374 says lanes "merged to main before the
  reviewer could verify them"; 10 desktop-spotlight lanes merged with no review entry.
- **Merge commits defeat rule 47.** STAGING-VERIFY reads the VTID from the commit subject (`run.mjs:375`); four
  `Merge pull request …` commits (v1 #1447/#1450/#1451/#1452) made community-app STAGING-VERIFY fail rule 47
  (runs 39952660840, 39870086198, 39783669906). `lane-land.md` step 3d says only "the method recent merged PRs use".
- **No written per-type checks.** `planning.md:32-33` asks only for "**Acceptance** bullets"; 0 of 8 sampled specs
  cover outcome + edge states + 390 px + de/ar + a11y together. The reviewer checklist
  (`.kiro/agents/vitana-lane-reviewer.md:83-107`) judges the lane's Acceptance text; no `changes` verdict in 45 named
  mobile, a11y, edge states or UX. No staging spec uses axe; `scripts/ci-accessibility.js` is referenced by no
  workflow (ALWAYS 40). The vitana-v1 PR template (`.github/PULL_REQUEST_TEMPLATE.md:15`) still points at the dead GCP
  Cloud Run preview `community-app-q74ibpv6ia-uc.a.run.app`; 2 of 12 sampled UI PRs had 1400 + 390 screenshots.

## 3. Change — three lanes, no shared file
- **Lane `pipeline-quality`** (vitana-platform). New `.kiro/pipeline/quality-checks.md`: (1) what "verified" means
  (the user-visible outcome observed on the deployed staging build, or proven by a behaviour test and stated in the PR
  as *not verified on staging: <reason>*); (2) the Acceptance template every lane in `tasks.md` uses (Outcome in the
  user's words, States, Surfaces, Locales, Accessibility, Contract, Staging proof; "n/a" allowed with a reason);
  (3) one section per change type — UI, Backend, Database, Integration, Infrastructure/CI, Tooling/docs — each with
  what the plan must state, the build checks, the staging proof and what the reviewer checks, each item traced to the
  §2 evidence; (4) test-quality rules for all types (a new staging spec compiles and is listed before push; no volatile
  pins, and a move/rename greps every test and `staging-tests.json` for the old location; real readiness waits; UTF-8
  without BOM); (5) merges are squash so the subject keeps the VTID. Wire it in with one sentence each:
  `planning.md` §3 (tasks.md Acceptance follows the template), `lane-code.md` steps 7–9 (apply the rows for the lane's
  change types, staging proof asserts the change, PR body says verified or not and why), `lane-review.md` (the review
  step's prompt passes the rows for the lane's change types as checklist item 10, which the agent definition already
  supports), `lane-land.md` step 3d (squash). The platform PR template gets a `## Verification` section (change types,
  what was observed where, screenshots for UI or the reason) without any VALIDATOR-CHECK marker word. A
  `node:test` file `scripts/collab/quality-checks.test.mjs` (run by PR-GATE's Collab tests job,
  `.github/workflows/PR-GATE.yml:140`) checks structure and links, not sentences.
- **Lane `staging-manifest-bom`** (vitana-platform). `scripts/ci/staging-verify/lib.cjs` gets
  `parseJsonText(text)` that removes one leading U+FEFF before `JSON.parse`; `run.mjs` `loadManifest` uses it.
  Tests in `scripts/ci/staging-verify/lib.test.cjs` (run by `STAGING-TESTS-REQUIRED.yml:33`): a BOM manifest parses to
  the same object as the BOM-free one; invalid JSON still fails; a BOM in the middle is not removed. Manifest
  validation (`validateManifest`) is unchanged, so no check gets weaker.
- **Lane `v1-pr-template`** (vitana-v1). `.github/PULL_REQUEST_TEMPLATE.md`: replace the dead Cloud Run preview line
  with the per-PR preview (`PREVIEW-DEPLOY-FRONTEND.yml`) and staging (`preview-aws.vitanaland.com`, read-only); add a
  `## Verification` section with the same change-type checks as the platform template (UI: 1400×900 and 390×844
  screenshots after the interaction or the reason, phone code path named, de + ar/RTL, keyboard/labels/contrast,
  edge states; staging proof asserts the change; Commerce: the UX acceptance section). Template only: it has no
  executable behaviour, so there is no red-on-base test; the reviewer checks the diff against Acceptance.
No dependency between the lanes; they run in parallel. Deploys nothing: no staging deploy workflow watches these paths
(`AWS-STAGE-DEPLOY-GATEWAY.yml:37-39` watches `services/gateway/**`), so no STAGING-VERIFY and no Gate 2; done when
the three lanes are merged green with closing records.

## 4. Tests (written first, recorded red on `origin/main`)
- `pipeline-quality`: `node --test scripts/collab/quality-checks.test.mjs` — `quality-checks.md` exists with the six
  change-type headings and the seven Acceptance fields; `planning.md`, `lane-code.md`, `lane-review.md` link it;
  `lane-land.md` names squash; the platform PR template has a `## Verification` section. Red on base: the file is
  missing. Also `node --test scripts/collab/*.test.mjs`, `node --test scripts/ci/kiro-steering/guard.test.cjs`,
  `node scripts/ci/kiro-steering/guard.cjs .`, preflight.
- `staging-manifest-bom`: `node --test scripts/ci/staging-verify/lib.test.cjs` — red on base: `parseJsonText` is not
  exported. `loadManifest` becomes a one-line call of the tested helper; `node --test scripts/ci/staging-verify/*.test.*`
  and `workflow.test.cjs` stay green.
- `v1-pr-template`: none (template only, see §3); the reviewer checks the diff.

## 5. Unchanged
Kiro session setup (`scripts/collab/kiro-web-session.mjs`), hooks, guards, `scripts/collab/preflight.mjs`,
`.kiro/pipeline/driver.md` and `AGENTS.md` (all in plan `kiro-web-reliability`, #4392); `scripts/ci/kiro-steering/**`
(#4388, #1499); `CLAUDE.md`, `.claude/**`, `.kiro/steering/**`, every protected gate file including
`.kiro/agents/vitana-lane-reviewer.md` (a checklist change there is recommended to the owner, not made here);
`validateManifest` and every rule-47 decision; every stop case.

## 6. Risks
- Written checks are guidance, not a lock. Accepted: the reviewer gets them as checklist item 10 on every lane, and
  the measurement in §7 shows whether they work.
- More Acceptance text per lane. Mitigated: "n/a" with a reason is allowed; the rows scale with change type.
- Stripping a BOM could hide a tooling problem. Accepted: the BOM carries no data, and the eight fix commits show the
  cost of rejecting it.

## 7. Measurement (from git and CI only)
Baseline 2026-09-27 → 10-27, re-measured four weeks after merge: follow-up fix chains per 100 merged PRs (same VTID or
screen, fix within 7 days); change suites passing STAGING-VERIFY on their first run; test-only fix commits; manifests
whose only proof is `existing` for a UI change; reviewer `changes` findings by category (mobile, a11y, edge state,
contract, staging proof); UI PRs with 1400 + 390 screenshots or a stated reason; rule-47 "missing" from merge commits
(target 0); BOM-only fix commits (target 0).
<!-- plan:end -->
