# VTID-03852 — Operator on-ramp transparency + dead Anthropic-direct code retired

Companion work in the same PR, own VTIDs, own acceptance criteria below:
**VTID-03853** (real Bedrock-Claude merge review, wired into the actual
dev_autopilot_executions merge path) and **VTID-03854** (dev-autopilot
planner: stop silently substituting a stub plan whenever ANTHROPIC_API_KEY
is unset, which AWS deliberately never sets).

## Report

Follow-up to VTID-03835's Operator Console read-access PR. The user asked,
after that PR merged: "which part of the execution is done by DeepSeek and
which is execution by Claude Code" for the Operator on-ramp. Tracing the
actual code (not the pipeline's own naming) found: (1) the Command Hub never
surfaced which provider actually wrote a given execution's diff, silently
implying Claude-quality authorship for DeepSeek-authored code; (2) two files
(`dev-autopilot-execute.ts`, `dev-autopilot-planning.ts`) still carried
module-level `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE` constants and a function
literally named `callMessagesApi`, years after VTID-02686 rewired the real
call to go through `callViaRouter()` — misleading dead code implying an
Anthropic-direct path that could not work anyway (`ANTHROPIC_API_KEY` is
never populated in AWS Secrets Manager per this repo's own CLAUDE.md §1b);
(3) investigating (2) in `dev-autopilot-planning.ts` surfaced a real,
previously-undiscovered production bug (VTID-03854, below) rather than just
dead code; (4) `services/autopilot-worker` — the one place real Claude Code
CLI execution exists in this platform — is orphaned (undeployed, its gate
unset on both staging/prod, and structurally bypassed by the on-ramp
regardless), documented explicitly rather than left to be rediscovered.

The user approved all four changes explicitly ("Agreed, I follow your advice
what to change. Go ahead!").

## Acceptance Criteria

AC-1 — Every `dev_autopilot_executions` card rendered by the Command Hub
(both `renderDevAutopilotExecutionCard` in the Autopilot Developer panel and
the independent card builder in the Autopilot Overview dashboard) shows a
badge naming the real LLM provider/model for that execution — either the
`metadata.llm_on_ramp_override` provider/model, or an explicit "policy
default" label when no override is set. Never blank, never silently
omitted — "policy default" is itself informative.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03852-llm-provider-badge.test.ts`, all 4 cases (including the
CSS-class assertion — see `commands.log`'s CSP Governance Gate section for
why this ended up as a class rather than a scripted inline style).

AC-2 — `dev-autopilot-execute.ts` and `dev-autopilot-planning.ts` no longer
declare `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE` as module-level constants, and
`callMessagesApi()` is renamed to `callRoutedLlm()` in both files (its real
implementation — `callViaRouter(...)` — is unchanged; only the misleading
name and the dead constants are removed).

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03852-dead-anthropic-code-removed.test.ts`, all 3 cases, and
`test/vtid-03854-planning-stub-gate.test.ts`'s "never reads ANTHROPIC_API_KEY"
/ "callMessagesApi was renamed" cases.

AC-3 — `services/autopilot-worker/README.md` and
`dev-autopilot-worker-queue.ts`'s module doc both carry an explicit status
note: not deployed anywhere in AWS (not in CLAUDE.md §1b/§2's service table,
not built by any `AWS-*-DEPLOY-*.yml`), its gate
(`DEV_AUTOPILOT_USE_WORKER`) unset on both `AWS-STAGE-DEPLOY-GATEWAY.yml`
and `AWS-PROD-DEPLOY-GATEWAY.yml`, and structurally bypassed by the operator
on-ramp regardless of that gate.

TEST: `commands.log` — the README and module-doc text are included in the
PR diff; reviewed directly (this is a documentation change, not something a
jest suite asserts against).

## VTID-03853 — real Bedrock-Claude merge review, wired into the actual merge path

### Report

The user's approved recommendation was "replace the `autopilot-validator.ts`
stubs with a real Bedrock-Claude review pass." Investigating where
`autopilot-validator.ts`'s `validateForMerge()` (which calls the stub
`runCodeReview()`/`runSecurityScan()`) is actually invoked found it is
**not called anywhere in `dev-autopilot-execute.ts` or
`dev-autopilot-watcher.ts`** — the files that actually drive
`dev_autopilot_executions` through to a merge. That pipeline's real merge
gate (`dev-autopilot-watcher.ts`'s `ciWatcherTick()`) is: GitHub CI green +
`shouldAutoMerge(riskClass)` (a risk-class allowlist, no content
inspection) → straight to `githubService.mergePullRequest()`. No code
review, no security scan, no LLM review of any kind ever touched this path,
regardless of which provider authored the diff. Fixing the orphaned
`autopilot-validator.ts` stub would not have protected anything real; the
fix below is wired into the path that matters instead.

### Acceptance Criteria

AC-1 — New `dev-autopilot-llm-review.ts` fetches the PR's changed-file diff
(`githubService.getPrFiles`, widened to also read GitHub's `patch` field)
and calls `callViaRouter('validator', ...)` — the DB-backed
`llm_routing_policy` 'validator' stage — asking it to flag only concrete
security/correctness problems (hardcoded secrets, injection, disabled
auth/RLS, destructive operations without guards, obviously broken code),
returning a strict `{"verdict":"pass"}` / `{"verdict":"block","reasons":[...]}`
JSON verdict.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03853-llm-merge-review.test.ts` "passes cleanly..." and "blocks
on a real block verdict..." cases.

AC-2 — The review is wired into `ciWatcherTick()` AFTER the CI-green and
risk-class gates and BEFORE the actual `mergePullRequest()` call — the only
point in the pipeline where a diff's real content is ever inspected before
an autonomous merge. A blocked verdict transitions the execution from
`merging` to `failed` and routes through the existing self-healing bridge,
the same shape as the pre-existing risk-class decline right above it.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03853-watcher-review-wiring.test.ts`, all 4 cases (source-level
wiring guard — `ciWatcherTick()` itself needs a live Supabase + GitHub
connection and isn't unit-testable in isolation, same established limit as
this file's other Supabase-dependent helpers).

AC-3 — The review fails OPEN (never blocks a merge) on any infrastructure
problem — diff-fetch failure, LLM call failure, or an unparseable response —
logging loudly via `console.warn` and an OASIS event so a stuck 100%-skip
rate would be visible. It blocks ONLY on a genuinely parsed "block" verdict.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03853-llm-merge-review.test.ts` "fails open (does not block)
when the diff fetch throws", "fails open when the router call itself
fails", "fails open when the response cannot be parsed" cases.

AC-4 — Kill-switched off by default (`DEV_AUTOPILOT_LLM_REVIEW_ENABLED`),
pinned to `"true"` on staging only — never prod — matching this platform's
standing practice for new autonomy-adjacent gates (VTID-03706, VTID-03820).

TEST: `commands.log` — diff of `AWS-STAGE-DEPLOY-GATEWAY.yml` shows the
flag added to both the filter-out list and the re-add list with
`value:"true"`; the same diff confirms `AWS-PROD-DEPLOY-GATEWAY.yml` is
untouched by this PR.

AC-5 — `tsc --noEmit` is clean and the full gateway test suite still
passes unmodified.

TEST: `outputs/tsc-noemit.txt` (exit 0, no output);
`outputs/jest-full-suite-summary.txt` — 766/767 suites (1 pre-existing
skip), 13,918/13,953 tests, 0 failures.

## VTID-03854 — dev-autopilot planner: real planning was silently replaced by a stub

### Report

Discovered while investigating VTID-03852's dead-code cleanup, not
originally in scope for this PR — flagged and fixed here rather than
silently deferred, per this repo's own "never hide a governance failure"
rule. `runPlanningSession()` in `dev-autopilot-planning.ts` short-circuited
to `buildStubPlan()` at its very first line whenever `ANTHROPIC_API_KEY` was
unset — checked BEFORE even attempting the routed call (worker queue, or
`callRoutedLlm()` via `callViaRouter('planner', ...)`, which since VTID-02686
could succeed via Bedrock/DeepSeek regardless of that key). Per this repo's
own CLAUDE.md §1b, `ANTHROPIC_API_KEY` is deliberately never populated in AWS
Secrets Manager — meaning on the real deployed gateway this gate was
permanently true: every autonomous-plane finding whose worker queue was
unavailable silently received the generic 8-line stub template instead of a
real, LLM-authored plan, in production, indefinitely.

### Acceptance Criteria

AC-1 — The `ANTHROPIC_API_KEY` gate is removed from `runPlanningSession()`.
The routed call is now always attempted when the worker queue is
unavailable/disabled.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03854-planning-stub-gate.test.ts` "never reads ANTHROPIC_API_KEY"
and "gates the stub plan on isPlanningStubEnabled()" cases.

AC-2 — The stub plan generator becomes an explicit, off-by-default opt-in
(`DEV_AUTOPILOT_PLANNING_STUB_ENABLED`, new exported `isPlanningStubEnabled()`)
for exercising the UI/pipeline without a live LLM call — never an accidental
production substitute. It is not pinned anywhere (staging or prod) in this
PR, matching its intended dev/test-only purpose.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03854-planning-stub-gate.test.ts`'s `isPlanningStubEnabled`
describe block, all 3 cases; `commands.log` confirms no deploy workflow
references the new var.

AC-3 — The worker-binary-missing fallback retry (self-healing: route around
a dead worker daemon without human intervention) no longer requires
`ANTHROPIC_API_KEY` either — it always attempts the routed fallback call.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03854-planning-stub-gate.test.ts` "the worker-binary-missing
fallback retry no longer requires ANTHROPIC_API_KEY" case.

AC-4 — A genuine call failure (every configured provider actually
unreachable) still surfaces as a real, visible `{ok:false,error}` — this
path was already correct before this VTID and is unchanged.

TEST: `outputs/jest-new-vtid-suites.txt` —
`test/vtid-03854-planning-stub-gate.test.ts` "a genuine call failure still
returns a real {ok:false,error}" case; `outputs/jest-full-suite-summary.txt`
confirms `dev-autopilot-planning.test.ts`'s pre-existing suite (14 tests,
`buildPlanningPrompt`/`buildStubPlan`/`extractFilePaths`) is unmodified and
still green.

---

**Known limitation, explicit, not silently deferred:** this whole change set
is verified structurally (unit tests, source-level wiring guards, `tsc`,
full suite, `npm run build`) but not yet observed against live staging
traffic — no AWS/Supabase credentials are reachable from this session to
watch a real `dev_autopilot.execution.llm_review_*` event land, or a real
autonomous-plane finding produce an LLM-authored (not stub) plan. The next
real signal is the first staging execution after this deploys.

OASIS_PROOF: `dev-autopilot-watcher.ts` emits
`dev_autopilot.execution.llm_review_passed` / `..._blocked` (new
`CicdEventType` union members, `types/cicd.ts`) for every execution that
reaches the new gate — verified structurally by
`test/vtid-03853-watcher-review-wiring.test.ts`'s "emits an OASIS event for
both the passed and blocked outcomes" case; not yet observed as a real event
in `oasis_events` (no live DB access from this session).
