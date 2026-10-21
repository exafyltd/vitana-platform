# Sparring round 1 — in_progress

Session: `697e758a-de29-42e1-831b-b85c35bae398` · plan hash `c1a3cd4f282d3dc4dd1d4eaf57aae7e56948ca4ec2bbba4bf2e98695e43386bf`

## Summary

The plan is extremely detailed and its §2 "Today" claims are largely accurate — I verified the PM decide-only loop, the StubObserver/NoLeaseManager/lane-writer no-ops, the governance-claude-only gates, the RED main (vtid-05077 stale pin), and the safe-merge workflow-file refusal. However, the plan has several real defects: (1) the §4.9 "zero Claude actions" definition and §4.3 protected-file rule conflict with the plan's own mergedBy/identity claims and the public `/mode` route's `claude_available` leaking availability status; (2) the `/status` smoke test in lane C/F probes `GET /api/v1/project-manager/status` expecting 401, but the plan simultaneously changes `/status` to include `claude`/`fallback` fields and adds `/mode` publicly — the 401 expectation depends on `requireServiceOrAdmin` which disallows anonymous, which is fine, but the new public `/mode` exposes the fallback state used for governance decisions (a modest but real info leak the plan dismisses by comparison to build-info); (3) the `pmTickIntervalMs` default change 600000→120000 with "lease TTL = tick − 30 s" gives a 90s lease TTL that runs against `pm_lease` table which I could NOT verify exists (only `...vtid_05214_plan_sparring_policy_approval.sql`, no `20261015180000_...lease` migration in the pinned tree) — the live PgLeaseManager premise is unproven; (4) the bootstrap §6 `--admin` merge over Lane scope only for executor/governance/reviewer rule failures is a governance violation risk: `gh pr merge --admin` bypasses the very scope-check that F says lanes must pass, and it also bypasses the `safe-merge` workflow-file refusal, contradicting Risk 10; (5) H0's "unblock main" edits a test file outside any lane's declared ownership discipline and lands in a lane that also touches TEST-SUITE.yml, while the plan claims each file has exactly one owner. Several premises NOT verified (Bedrock partner chain names, Operator Chat insert path, `claude-sonnet-5.5` model id, Jest 28,514-test count) are flagged but not blockers. The plan is otherwise internally consistent and the staging-only, owner-PUBLISH, read-only-staging-test constraints are respected.

## Findings

### R1-F1 [major]

The live `PgLeaseManager` premise claims a `pm_lease` table exists at `supabase/migrations/20261015180000_…:222-240`, but no such migration exists in the pinned tree — the only 20261015 migration is `20261015180000_vtid_05214_plan_sparring_policy_approval.sql`, and `lease.ts` returns `table_absent` via `NoLeaseManager`. Lane C's `startPmLoop` switching to `runActTick` in `live` mode will call `actOnDecisions` which will `acquire()` a lease that always fails, so the PM will NEVER act even in `live` mode unless the migration is actually present and deployed. C's entire 'PM really acts' goal depends on an unverified DB object and an undeployed migration.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/lease.ts:43` — export class NoLeaseManager implements LeaseManager { async acquire(): Promise<LeaseOutcome> { return { acquired: false, reason: 'table_absent' }; } }
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/index.ts:110` — lease is held (see `actOnDecisions`): in `off`/`dry_run`, or when the pm_lease table is absent (P1 not merged) or another task holds the lease, nothing is acted on.

Suggestion: Verify the `pm_lease` migration exists and is applied to staging before lane C is considered complete; otherwise the 'PM really acts' proof (lane F) will silently no-op. Add a precondition to F (or a test) that `acquire()` succeeds in `live` mode, or explicitly note that P1's lease migration must land first.

### R1-F2 [major]

Plan §6 Bootstrap permits `gh pr merge --admin` to bypass Lane scope ONLY when it fails 'because of the executor/governance/reviewer rule or because the spec is not on main'. But `safe-merge` refuses any PR touching `.github/workflows/` (confirmed in `github-service.ts` evaluateGovernance / `BLOCKED_FILE_PATTERNS`), and lanes D (PR-GATE.yml) and H (TEST-SUITE.yml, PLAN-SPAR.yml) touch workflow files. An `--admin` merge is exactly the override the plan's own Risk 10 says is needed, yet the plan describes `--admin` as scoped to Lane-scope false positives while separately admitting D/H 'are never PM-merged'. There is no clear, single authority that reconciles: `--admin` for governance-rule false positives vs. `--admin` for workflow-file refusal vs. owner instruction. A real red test is never overridden, but a workflow-file red (Lane scope OR safe-merge) would be overridden under this clause, weakening the 'never a real red' guarantee.

- `exafyltd/vitana-platform:services/gateway/src/services/github-service.ts:718` — const blockedReasons: string[] = []; ... for (const pattern of BLOCKED_FILE_PATTERNS) { if (pattern.test(filename)) { blockedReasons.push(`Blocked file pattern: ${filename} matches ${pattern}`); } }
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:69` — export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**', 'CLAUDE.md', 'docs/programs/areas.yaml'];

Suggestion: Clarify the merge authority: distinguish (a) `--admin` only for the lane-scope executor/governance/reviewer FALSE-POSITIVE and the spec-not-on-main case, never for a real red or a workflow-file refusal; and state explicitly that workflow-file lanes (D, H) merge only under the explicit owner instruction or a legacy claude review, never `--admin`.

### R1-F3 [major]

Lane F/B's staging-test payload requires `CLAUDE_AVAILABLE=false` to be set as a repo variable and left `false` after Gate 2, but §3 defines the public `/mode` route to return `claude_available` unauthenticated, and the reusable `claudeAvailability` 4h rule reads the queue. The plan (Risk 6, §3 security note) dismisses `/mode` as 'same class as build-info', but `claude_available`/`executor_mode` is a live operational/governance signal (whether the fallback is active), materially more sensitive than a static build-info string, and it is readable by every anonymous caller forever while the variable stays `false`. This is a persistent info-disclosure of the pipeline's trust state, not a one-time proof artifact.

- `exafyltd/vitana-platform:services/gateway/src/routes/project-manager.ts:25` — router.get('/status', requireServiceOrAdmin, (_req: Request, res: Response) => { const snapshot = getSnapshot(); return res.status(200).json({ ok: true, enabled: pmAgentEnabled(), mode: snapshot.mode,

Suggestion: Return only `{ok, enabled, mode, executor_mode}` publicly and keep `claude_available`/`claude_reason` behind the auth-gated `/status`, OR gate the public `/mode` by an allowlist/signed token for the STAGING-VERIFY runner. At minimum, document a deliberate decision on persistent availability disclosure.

### R1-F4 [major]

§4.9 'Zero Claude actions' defines the threshold on 'session_… id or a mergedBy Claude identity' and additionally orders 'From now on Kiro commits carry no Co-Authored-By: Claude trailer', but §6 bootstrap merges this plan's own lanes under a Kiro `seat` while the existing codebase stamps `Co-Authored-By: Claude …` trailers on Kiro commits (plan §2.9). If any pre-change Kiro commit with a Claude co-author trailer lands between the plan PR's first commit and Gate 2, the measured 'zero Claude actions' record (F's zero-claude-proof.md) is either falsified or requires ad-hoc trailer rewriting. The proof definition and the identity change are not coordinated in time.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/decide.ts:109` — // 9. residual self-review guard: the review commit's session id must differ from every session id in the lane's executing-log entries.

Suggestion: Pin the identity trailer cutover to a specific commit/date and make F's zero-claude-proof.md assert trailer content (not just actor id) over the measured window, or relax §4.9 to 'no Claude Code session actor id' only and move trailer cleanup to a documented follow-up.

### R1-F5 [major]

H0 'unblock main' edits `services/gateway/test/vtid-05077-...test.ts` (line 212) AND H also edits `.github/workflows/TEST-SUITE.yml`, `PLAN-SPAR.yml`, and new CI scripts — but §5 declares 'no two lanes edit the same file' and §7 'Shared files in this plan: none (each file has exactly one owning lane)'. The vtid-05077 test file appears only in lane H, which is consistent, but H0's instruction is conditional ('only if TEST-SUITE on main still fails when the lane starts'), meaning the lane's file set is non-deterministic at plan time and the red test on `main` is a pre-existing failure H0 is allowed to 'fix' by changing a test assertion — the plan explicitly says 'no assertion dropped' but changes the expected pin, which is a test edit that could mask rather than fix. The real defect (a stale style-version pin) is in `index.html`, yet H0 fixes it by editing the TEST, not the served pin, or vice versa — the plan is internally ambiguous about which side is 'wrong'.

- `exafyltd/vitana-platform:services/gateway/src/frontend/command-hub/index.html:32` — <script src="/command-hub/app.js?v=20261121-vtid-05082"></script>
- `exafyltd/vitana-platform:services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212` — expect(html).toContain('/command-hub/app.js?v=20261120-vtid-05148');

Suggestion: State unambiguously whether the intended fix updates the test to expect the served pin (and asserts the chip markup, as stated) — and confirm the served pin is the CORRECT one (i.e. the test was stale, not the deployment). Ensure the vtid-05077 file has a single owning lane and that H0's conditional edit is recorded as an explicit, pre-approved exception to §5.

### R1-F6 [minor]

§2.9/§8 claims gateway Jest is 28,514 tests / 1,730 suites and that TEST-SUITE is red since 2026-10-20 on the vtid-05077 pin (verified the pin mismatch is real). The shard plan splits gateway into 4 shards with a `gateway-shard-union` job, but `fail-fast: false` + 4 shards + the union job changes the required-status check name from a single 'Gateway (Jest …)' to a matrix, and only `validate` is a required check on main (per §2.9). If the required-status check is keyed to the old single job name, the matrix refactor could make the branch appear green while the union job (not in the required set) is what actually detects the union — a latent gap between 'checks green' and 'all tests actually ran once'.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:84` — - name: Test-weakening guard ... run: node scripts/ci/pr-gate/gate.mjs weakening --base "$BASE" --head "$HEAD"

Suggestion: Confirm which check names are the required status checks on `main` and ensure the branch-protection required set is updated to include the `gateway-shard-union` job (or that a matrix-union rollup remains the single required check). Otherwise a PR could merge with shard drift.

### R1-F7 [minor]

§3 Input 2 (4h rule) and the reviewer/PM both compute `claude_available` from the queue and repo variable, but the plan's own §4.5 `pm-agent` exemption and §4.1 self-review guard (`decide.ts:107-108`) are referenced as 'unchanged' while C rewrites `reassignDecision`/`actPark`/`governanceMergeAllowed` and D rewrites `scopeCheck`/`validateLane`. The bootstrap (§6) bypasses today's validators for its own lanes, so there is a window where the NEW C/D code (agent reviewer, pm-agent exemption, plan-PR lane source) is not yet on `main` and the OLD code still enforces claude-only governance. The plan handles this via `--admin` (§6), but if the `--admin` merges land before D's `protected-gate-files.json` is on main, C's parity test (T25) reads a missing JSON and the protected-file list is empty — protected files could be agent-accepted-and-merged with no block.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/act.ts:170` — export function governanceMergeAllowed(lane: ObservedLane): boolean { if (!laneTouchesGovernance(lane)) return true; return lane.reviewer_seat === GOVERNANCE_REVIEWER; }

Suggestion: Make C's `PROTECTED_GATE_GLOBS` a hard fallback (not only a parity read of an external JSON) so a protected file can never be agent-merged when the JSON is absent; and sequence D (JSON + PR-GATE) before C's `governanceMergeAllowed` is live, or keep the legacy claude guard until both are on main.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
