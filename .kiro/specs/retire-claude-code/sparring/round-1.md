# Sparring round 1 — in_progress

Session: `d1b25dea-ce0e-4b73-a46b-350d1fdc0c5b` · plan hash `160e6ed594f60f114158f8c84926f80621d5e7ef65aeda9f2caaeea623fa5bd0`

## Summary

The plan is well-researched and its measured-state claims about queue.mjs check out (GOVERNANCE_PATHS gating, permission-field restriction, reviewer_seat:claude requiring session_ reviews, ubuntu-latest/Playwright 1.51.0 in workflows). The core mechanism (a `governance: true` + `executor: kiro` escape hatch in validateLane and scopeCheck) is internally consistent. However there are real gaps: (1) the bootstrap depends on a §7b `--admin` override that is not present in queue.mjs's CLI and whose applicability to the distinct, fail-closed `lane-scope` job (separate from the gate.mjs scope guard §7b describes) is unproven — if no override exists for that job, the scope-rules PR itself cannot pass Lane scope under the old checker and the whole retirement blocks; (2) the governance review/merge boundary now rests entirely on self-reported seat prefixes in Kiro session ids where all Kiro accounts share one `exafyltd` GitHub identity, and the plan does not demonstrate code enforcement of the "different seat" and "owner's per-PR instruction" rules for governance merges; (3) the `_plan`/author_seat permission-change widening is under-enforced; (4) the CI runner lane's "every job that installs Playwright" scope is unreliable because STAGING-VERIFY (the very workflow the plan cites as failing) runs browser tests through run.mjs rather than a grep-able `playwright install` step.

## Findings

### R1-F1 [blocker]

The bootstrap relies on the owner '--admin'-overriding the governance-path false positive for the scope-rules PR, but queue.mjs has no --admin flag and the lane-scope job is a distinct, fail-closed check (not the gate.mjs scope guard §7b's '--admin-overridden governance-artifact check' describes). If there is no override path for the lane-scope job, the scope-rules PR fails Lane scope under the old checker and cannot merge, blocking all five lanes.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:700` — if (cmd === 'scope-check') { ... return r.errors.length ? 1 : 0; }
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:634` — function parseArgs(argv) { ... const flag = ['json', 'stale'].includes(k); ... }
- `exafyltd/vitana-v1:.github/workflows/PR-GATE.yml:297` — # Fail closed: the Project Manager merges on this check, so a checker that cannot be fetched is red, never a silent pass.

Suggestion: Add to the plan an explicit, code-verified mechanism for the owner to make the scope-rules PR's lane-scope check pass (e.g. an --admin flag in scope-check, or a documented owner branch-protection admin merge), and confirm it maps to the lane-scope job, not just gate.mjs's scope step. State concretely how the Project Manager/merger treats a documented per-PR owner override of this red check.

### R1-F2 [major]

Governance review authority is now delegated to 'a different Kiro seat', but all Kiro accounts share one GitHub identity (exafyltd) and the seat is established purely by the self-reported prefix in a commit's session id. The queue.mjs review check maps session->seat via seatOf() which returns '' for the legacy no-seat kiro-YYYYMMDDHHMM-xxxx form; the plan does not show how the new 'different Kiro seat' rule excludes a weakly- or self-identified reviewer, nor any code enforcement that a governance PR merged only on the owner's explicit per-PR instruction plus a different-seat review.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:60` — const SESSION_RE = /^(session_[A-Za-z0-9]+|kiro-(?:[a-z]{1,12}-)?\d{12}-[0-9a-f]{4}|pm-agent|ci-plan-spar)$/; ... export const seatOf = (s) => (/^kiro-([a-z]{1,12})-\d{12}-[0-9a-f]{4}$/.exec(s || '') || [])[1] || '';
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:474` — if (k.review === key && k.lane !== key) { const ok = fm.reviewer_seat === 'claude' ? /^session_/.test(k.session) : !fm.reviewer_seat || seat === fm.reviewer_seat; ... }
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:84` — All Kiro accounts share one GitHub identity (`exafyltd`), so GitHub labels or `/kiro` comments cannot address one account

Suggestion: Specify the code change that makes a governance lane's validating review require a session id naming a real seat that (a) != the lane's seat and (b) resolves to a seat listed in docs/programs/areas.yaml, and explicitly reject the legacy no-seat `kiro-YYYY…` form for governance reviews. Document — and where possible enforce — that a governance PR merges only with the owner's explicit per-PR instruction, since the 'different-seat review' alone is the new sole technical boundary.

### R1-F3 [major]

The plan centralises governance into documentation (§7c 'governance guard', automation files 'never merge or deploy') but the new `governance: true` field enables an `executor: kiro` lane to touch any governance path with only a 'reviewer_seat != seat' requirement. There is no code that verifies a governance lane's PR was built/reviewed by different seats on the current head or that the owner gave a per-PR instruction; the existing scopeCheck PERM block (:448-460) currently only lets session_ sessions on executor:claude lanes change lane powers, and the plan re-writes this to a looser author_seat/_plan rule without showing the enforcement of the different-seat/owner-instruction pair.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:447` — const changed = PERM.filter(...); const claudeOnly = sessions.size > 0 && [...sessions].every((x) => /^session_/.test(x)); if (changed.length && !(baseFm.executor === 'claude' && claudeOnly)) { errors.push(...) }
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:69` — export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**', 'CLAUDE.md', 'docs/programs/areas.yaml'];

Suggestion: For governance:true lanes, require validate/scope-check to prove the build commit and the review entry come from two different named seats (both in areas.yaml) and neither is a weak/unseated session, and record the owner's per-PR instruction reference in the lane log as a merge precondition the merger (PM or Kiro) actually checks — not only prose in collaboration.md.

### R1-F4 [major]

The CI runner lane pins 'every job that installs Playwright', but STAGING-VERIFY — the workflow the plan itself cites as currently failing (community-app run 39397664080) — runs its browser step through `scripts/ci/staging-verify/run.mjs` (checked out and invoked at :191) with no visible `playwright install` step in the workflow YAML, and its verify job is `runs-on: ubuntu-latest` (:89). A grep-for-'playwright install' approach will miss it, leaving the very failure the lane is meant to fix unaddressed.

- `exafyltd/vitana-platform:.github/workflows/STAGING-VERIFY.yml:85` — jobs: verify: ... runs-on: ubuntu-latest
- `exafyltd/vitana-platform:.github/workflows/STAGING-VERIFY.yml:178` — - name: Run STAGING-VERIFY ... run: | node runner/scripts/ci/staging-verify/run.mjs verify --service "$SERVICE" --sha "$SHA" ...

Suggestion: Enumerate the exact 10 platform + 3 v1 workflows (file names) in the plan and confirm STAGING-VERIFY.yml is included; for run.mjs-driven browser installs, pin the runner in the workflow YAML regardless of where Playwright is installed (inspect run.mjs / its npm install path), and add a test asserting every `runs-on: ubuntu-latest` job that executes a browser test is pinned to ubuntu-24.04.

### R1-F5 [minor]

The plan asserts '.kiro/steering/* role text' needs changing, but the collaboration steering file is a one-line `#[[file:.claude/rules/collaboration.md]]` link, not role text. Whether other steering files (vitana-kiro-notes.md, vitana-standing-rules.md, vitana-load-project-rules.md) actually carry the 'Kiro plans/builds/reviews, Claude handles exceptions' role text is unverified, so the lane's file list may over- or under-specify what must be edited to fully retire the Claude Code role.

- `exafyltd/vitana-platform:.kiro/steering/vitana-collaboration.md:1` — # Claude Code ↔ Kiro collaboration (VTID-05145) — same paths as `.claude/rules/collaboration.md`

#[[file:.claude/rules/collaboration.md]]

Suggestion: Read each steering file (platform and v1) during planning and list exactly which carry role text to update; the plan should name them so a reviewer can confirm no Claude-Code-role phrase is left behind in a file the plan claims to cover.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
