# Quality checks, proportional to the change type

Binding: `common-rules.md`. Used by `planning.md` §3 (Acceptance in `tasks.md`), `lane-code.md` steps 7–9 (build and
PR body) and `lane-review.md` (the review prompt's checklist item 10). It adds checks; it relaxes no rule of
`CLAUDE.md`, `collaboration.md` or the other pipeline files. A lane applies the sections of every change type it
touches, and nothing else. Each item comes from a miss in merged work between 2026-09-27 and 2026-10-27 (plan
`quality-checks` §2); the reference in brackets is that miss.

## What "verified" means
- **Verified** = the user-visible outcome of the change was observed on the deployed staging build (STAGING-VERIFY
  passed on the merge commit with a suite that asserts that outcome), or for a non-deploying change, on the real
  artifact it changes (the workflow ran, the script ran on real input).
- A unit or integration test alone proves the logic, not the outcome. When the read-only staging rule (CLAUDE.md
  IF–THEN 31–32) makes the outcome unobservable, the PR body and the lane log say **not verified on staging:
  <reason>** and name the test that covers it. Never write "verified", "works" or "done" for something only
  unit-tested [VTID-05013 reached production and was rolled back; v1 #1440 Spotlight batches in production with red
  suites].
- A lane is not reported done before its review entry exists and its checks are green on the reviewed head [10
  desktop-spotlight lanes merged without a review entry; platform #4374].

## Acceptance template (every lane in `tasks.md`)
The first bullet is **Change types** — `Change types: <list>` from UI, Backend, Database, Integration,
Infrastructure/CI, Tooling/docs; the builder and the review step apply exactly those sections. Then write each field
from the user's side; "n/a: <reason>" is a valid answer, an empty field is not.
- **Outcome** — what the user (member, supplier, operator, CI) sees or gets afterwards, in their words; not a class
  name or a code fact [VTID-05332 asserted a `pb-[calc(…)]` string].
- **States** — empty, loading, error, offline, slow or late response, long text, no permission, as they apply.
- **Surfaces** — which screens and components render the change on a phone and on desktop, including redirects and
  `Mobile*` variants; for backend: which callers.
- **Locales** — de first (du-form) and en; ar (RTL) when layout changes; locale-format helpers for dates and numbers.
- **Accessibility** — accessible name, keyboard reach and order, visible focus, contrast (WCAG 2.2 AA, ALWAYS 40).
- **Contract** — for every boundary crossed: request, response status and content type, auth gate, error shape, with
  `file:line` on both sides.
- **Staging proof** — what the staging test asserts about this change (not only that the page or route exists), or
  "not verified on staging: <reason>" and the covering test.

## UI
(vitana-v1 screens, Command Hub)
- **Plan:** name every component that renders the screen on a phone (`useIsMobile`, `MobileAppShell`, `Mobile*`
  pages, phone redirects) [v1 #1340 → #1344: phone `/settings/privacy` redirects to `MobileSettings`, which never
  rendered the card]; Spotlight archetype or "phones get no Spotlight" [#1374–#1382 → #1399].
- **Build:** no hover-only control (`opacity-0` + `group-hover`) without a tap path [#1358 → #1359]; logical
  properties (`ms-`/`me-`/`start`/`end`) [#1359 `right-2` → `end-2`]; late-loading content does not move the user's
  anchor or overwrite their input [#1430 → #1433/#1434/#1436; #1429 → #1432]; the empty state keeps its summary
  [#1268 → #1269]; icon buttons have an `aria-label` from the catalogs.
- **Evidence:** Playwright screenshots at 1400×900 and 390×844 of exactly the changed element, before and after the
  interaction, viewed (CLAUDE.md "Targeted Visual Verification"); ar/RTL screenshot when layout changed. When the
  session cannot sign in, say so in the PR and let the staging spec carry the proof.
- **Staging proof:** a read-only Playwright spec at the viewport the change is about that asserts the outcome
  (element visible, scrolled into view, text present, no horizontal overflow), not a class string or a jsdom layout
  [66 of 193 v1 manifests were Vitest `existing` only].
- **Reviewer:** the phone code path, hover-only controls, edge states and accessible names in the diff.

## Backend
(gateway routes, services, workers)
- **Plan:** for each changed or new route: the middleware chain and auth gate (`requireServiceOrAdmin`, JWT,
  anonymous), status codes, content type, `file:line`.
- **Build:** error replies of streaming routes are JSON, not `text/event-stream` [VTID-05065 → VTID-05069, twice in
  one day]; AI calls log provider, model and latency (AI-29); spoken text is intent, never a sentence (NEVER 41).
- **Staging proof:** write the probe from the contract above, not from memory: the expected status for the
  unauthenticated or rejected path, plus an assertion of the changed response wherever a read-only path exists
  [VTID-05098, 05129, 05018, 04895 probes expected the wrong status; #4159/#4164 → #4194 expected anonymous 200 on a
  guarded route; VTID-05220 checked `/alive` + 401, not the mode it changed].
- **Reviewer:** the probe matches the route's real auth and content type; the mounted path exists.

## Database
(migrations, RLS, functions)
- **Plan:** the latest migration that defines each object you change (`grep -rn` in `supabase/migrations`), and what
  you keep: defaults, grants, RLS policies, triggers, signatures [#4114 → #4118 dropped the DEFAULT of
  `health_compute_vitana_index(date)`].
- **Build:** `CREATE OR REPLACE` restates every kept default and grant; `DATABASE_SCHEMA.md` updated (ALWAYS 24);
  tenant isolation and both test-account allowlists for any member-facing query (NEVER 43–45); a rollback note.
- **Staging proof:** applying the migration is an owner stop (`collaboration.md` §7d); until it is applied, say
  "not verified on staging: migration not applied" and prove the SQL with a local or pgTAP test.
- **Reviewer:** kept defaults, grants and policies against the previous definition.

## Integration
(frontend ↔ gateway, gateway ↔ database, vendor, MCP, push)
- **Plan:** the contract of each side with `file:line`; who owns the change when they disagree.
- **Build:** a test on each side of the boundary; ordering and races (an older reply must not overwrite a newer one)
  [#1429 → #1432]; partial failure and timeout behaviour; backend-supplied UI text ships `{ key, params }`.
- **Staging proof:** the consumer's request against the deployed producer (read-only).
- **Reviewer:** both sides agree on status, shape and auth; the race case is tested.

## Infrastructure/CI
(workflows, task definitions, deploy scripts)
- **Plan:** every file of the same kind the change must reach: all task definitions, all deploy workflows, both
  repos [VTID-04849 → 04858 → 04930: one dead secret removed one task definition at a time].
- **Build:** parse every changed workflow; no `secrets.` in a step or job `if:` (map it to `env` first) [#4266 →
  #4351, `PLAN-SPAR.yml` invalid for four days]; register a new workflow wherever the repo catalogs them
  (`services/gateway/specs/loop-catalog-v1.json`) [`CI-HEALTH.yml` merged unregistered; its entry is added by #4374];
  no change to `AWS-PROD-*` without an owner command.
- **Staging proof:** a run of the changed workflow on the PR or by dispatch on staging, linked; for a task-definition
  change, the deployed revision's value.
- **Reviewer:** the sweep covers every sibling file; the workflow run is linked.

## Tooling/docs
(collab scripts, pipeline files, rules, templates)
- **Build:** tests assert behaviour or structure, not sentences copied from another file [a VTID-04868 test pinned a
  CLAUDE.md line that VTID-05280 (#4239) removed; fixed in #4374].
- **Staging proof:** usually n/a (deploys nothing): the change is proven by its tests and one real run of the script.
- **Reviewer:** no rule weakened; links resolve.

## Test quality (every change type)
- A new or changed staging spec compiles and is listed before push (`npx playwright test --list <spec>`; for TS, `npx
  tsc --noEmit -p <config>` when the repo has one) [#1431 duplicate `const`; STAGING-VERIFY run 38753829317:
  `vtid-05085-enrichment-cards.staging.spec.ts` SyntaxError].
- Wait on a real readiness signal of the changed element, never on `#root *` `.first()` [#1440]; never `force: true`
  on an `aria-disabled` control [#1259–#1265 → #1272].
- No pin of a volatile value (cache-buster token, a rule sentence, a file location) unless that value is the change.
  A move or rename greps every test and every `docs/validation/*/staging-tests.json` for the old name and updates
  them in the same PR [#4182 → #4223/#4225 → #4258 → #4374].
- Files written by tools are UTF-8 without a BOM (PowerShell 5.1: `[IO.File]::WriteAllText($p, $s, (New-Object
  Text.UTF8Encoding $false))`) [8 v1 BOM-only commits, e.g. `36d702bfd`].
- A test is red on `origin/main` for the reason the change fixes, not for a module-resolution or setup error.

## Merge
Squash merge, so the subject carries the PR title's VTID: STAGING-VERIFY reads VTIDs from commit subjects
(`scripts/ci/staging-verify/run.mjs`, `lib.extractVtids(c.subject)`), and a `Merge pull request #n from …` subject has
none, which fails rule 47 for the whole release [v1 #1447/#1450/#1451/#1452; STAGING-VERIFY 39952660840].
