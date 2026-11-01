---
lane: rules
state: ready
next_actor: kiro
depends_on: [enforcement]
executor: kiro
seat: jtadic
area: frontend
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-platform, exafyltd/vitana-v1]
updated: 2026-10-29T11:49Z
vtid: VTID-05409
---
# Lane `rules`: human-facing rule text, consistently Claude-free
Plan: `.kiro/specs/kiro-lane-admin/` — `plan.md` and the `tasks.md` section `<!-- lane: rules -->` are authoritative.
Design: `design.md` §6. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Depends on `enforcement` being on `main` so the rule text matches what code enforces.

**Paths (declared at build time, not here):** `.claude/rules/collaboration.md`, `CLAUDE.md`,
`.kiro/pipeline/common-rules.md`, `.kiro/steering/vitana-owner-autonomy.md`, `docs/validation/VTID-*/**` (platform);
the byte-identical `CLAUDE.md` mirror in a sibling vitana-v1 PR. `paths` are not declared in this `plan(` lane file
because `CLAUDE.md` is a protected-gate path the current `validateLane` refuses on an `executor: kiro` lane (the rule
this plan repairs). Added when the lane goes `executing`; merge under the owner-instruction authority in `plan.md`.

Rewrites the protected-gate authority to "the owner's instruction naming the plan plus a reviewer-agent accept on the
current head" and adds one sentence on the authorized `lane_admin` reviewer-agent lane-administration path, in
`collaboration.md` (§3a/§7/§7a/§7b), `CLAUDE.md` (platform), `common-rules.md` rule 4 and `vitana-owner-autonomy.md`
stop #3. The byte-identical `vitana-v1/CLAUDE.md` mirror is carried in a sibling vitana-v1 PR of this lane (sha256 in
the PR body). `vitana-collaboration.md` stays a `#[[file:]]` link (no body edit).

**Protected gate file (§3a):** this lane changes `CLAUDE.md`. Merge only on the owner's instruction naming this plan
(handoff.md) plus a reviewer-agent accept on the current head. The other files are governance paths, satisfied by the
reviewer agent on the current head. `scripts/ci/kiro-steering/guard.cjs` must stay green.

## Log
### 2026-10-29T10:45Z · kiro-jtadic-202610291040-a0e6 · created → ready
Lane drafted with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat `jtadic` claims it (after `enforcement` is
`done`).

### 2026-10-29T11:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05409 allocated after policy approval (converged-auto-v1).

### 2026-10-29T11:55Z · kiro-jtadic-202610291040-a0e6 · build (front matter unchanged; left ready/path-free)
Built the Claude-free rule-text changes on branch `kiro/kiro-lane-admin/rules` in both repos, matching the merged
VTID-05408 enforcement (`fdd6436ca8`). Platform edits:
- `.claude/rules/collaboration.md` — §3a and §7b protected-gate authority → "the owner's instruction naming the plan
  plus a reviewer-agent accept on the current head (Claude Code is retired)"; §7a adds one sentence on the authorized
  `lane_admin` / `reviewer_seat: agent:vitana-lane-reviewer` lane-administration path (reassign a TARGET lane's `seat`,
  narrow its `paths`; preserves seat ownership, scope, independent review; never widens the admin lane's own `paths`;
  trusted-source only, never self-granted in the PR head) — wording matched to the `queue.mjs` refusal strings and the
  `validateLane` marker.
- `CLAUDE.md` (platform) — protected-gate sentence → Claude-free wording.
- `.kiro/pipeline/common-rules.md` rule 4 and `.kiro/steering/vitana-owner-autonomy.md` stop #3 — same reword.
vitana-v1 edit (sibling PR on branch `kiro/kiro-lane-admin/rules`): `CLAUDE.md` protected-gate sentence, byte-identical
to the platform sentence (normalized sha256 `6aa1041d27f8f5511155b5c13003dce8e20dbda303e0c60e45261afbca9928f5`,
`docs/validation/VTID-05409/outputs/claude-md-sha256.txt`).
`.kiro/steering/vitana-collaboration.md` left as a `#[[file:]]` link (no body edit). `scripts/ci/kiro-steering/guard.cjs`
and `node scripts/collab/queue.mjs validate` both green (`outputs/`). Validation records under
`docs/validation/VTID-05409/`. Front matter unchanged; lane kept `ready` and path-free so `validateLane` passes (the
protected-gate paths are recorded in `docs/validation/VTID-05409/scope.json`, not the lane file). Merge under the
owner-instruction authority in `plan.md`/`handoff.md` plus a reviewer-agent accept. The orchestrator pushes both
branches, opens the PR(s), runs the reviewer agent and merges.

### 2026-10-29T14:55Z · agent-vitana-lane-reviewer-202610291448-b81a · review
review: accept
head: 9502f7eaeab1df397af3ec91bbd330264bd8190a
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4498 (sibling: exafyltd/vitana-v1#1519 head cba5fe87736530b65542db426d852289bcc69360)
Findings: non-blocking — (1) both repos' CLAUDE.md are protected gate files; merge also needs the owner instruction naming the plan (recorded in handoff.md) plus this accept, verified at the land step; (2) live CI unreadable from the reviewer sandbox, judged from committed evidence (queue.mjs validate green, kiro-steering guard OK, no-legacy-claude grep clean across all changed rule files, independently re-confirmed).
Verified: scope confined to scope.json paths (platform 4 rule/steering files + docs/validation; v1 CLAUDE.md + docs/validation; lane file log-entry-only, front matter unchanged); §3a/§7b + platform & v1 CLAUDE.md + common-rules.md rule 4 + vitana-owner-autonomy.md stop #3 all Claude-free with no "legacy claude review" option remaining; the §7a lane_admin sentence matches the merged enforcement with no behavioural drift (never says a reviewer-agent accept alone unlocks a protected gate file, never says the admin lane can widen its own paths); the two CLAUDE.md sentences byte-identical (sha256 6aa1041d…); vitana-collaboration.md untouched (#[[file:]] link). No migration, no live-system writes, nothing routed to Claude.
Next: land under §7b — both CLAUDE.md are protected gate files, so with the owner's instruction naming the plan (recorded) plus this accept on the current head; confirm required checks green on both heads first.
