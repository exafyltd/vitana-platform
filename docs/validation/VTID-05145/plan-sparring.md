# Plan sparring record — Claude Code ↔ Kiro collaboration protocol (VTID-05145)

- Partner: plan-sparring-partner (independent, read-only), one partner across all rounds
- Class: standard; rounds: 5 (rounds 4–5 a single owner-directed change — parallel sessions — skill §6 pattern)
- Plan hash (sha256 of text between plan markers): e5503d12aa08f4a893bee7ae0f208c49a9b9f8688932a96d67affe2901187b49
- Verdict: **CONVERGED** (no open or disputed blocker/major; F1–F15 all ACCEPTED)
- Owner approval: chat 2026-10-13 Gate 1 yes ("Yes, approved. Go ahead.")
- VTID: VTID-05145 (one VTID, two PRs: vitana-platform + vitana-v1). Deploys nothing → no Gate 2.

## Rounds
- R1: F1 (major) committed INDEX.md conflicts · F2 (major) race on next_actor · F3 (major) byte-identical copies ·
  F4–F7 (minor) transitions, Routine versioning, goal wording, CLAUDE.md growth — all ACCEPTED.
- R2: F1–F7 closed; F8 (major) stale INDEX.md text, F9 (minor) orphan claims — ACCEPTED.
- R3: CONVERGED.
- R4 (owner: dozens of parallel Kiro sessions, never mix sessions): F10 (major) §5 spec-level, F11 (major) queue
  spec-level, F12/F13 (minor) roles, coordinator — ACCEPTED.
- R5: CONVERGED; F14/F15 (minor) lane state set, claim glob depth — ACCEPTED.

## Plan and full round record (verbatim)

# Plan — Claude Code ↔ Kiro collaboration protocol (no human relay)

<!-- plan:begin -->
## Goal
Owner ask (2026-10-13): Claude Code and Kiro IDE work as a team across hundreds of sessions without the owner
copy-pasting between them. Precisely (R1 F6): the owner never relays content; the only human touch left is opening
Kiro and typing "continue" — Claude is woken by a Routine. Either agent can author a plan; the other executes it; the author (or the other agent)
verifies. Everything one agent produces must be readable by the other.

## Change class
**standard** — touches `.github/workflows/PR-GATE.yml` (one step), `scripts/ci/**`, `CLAUDE.md` in both repos,
`.kiro/steering/**` in both repos, and creates a cloud Routine. No migrations, routes, auth, deploy, or LLM routing.
Nothing deploys (docs + CI script only) → no Gate 2; done when merged with green checks.

## Facts this builds on (verified in the code)
- Kiro already reads/writes committed specs: `vitana-v1/.kiro/specs/desktop-spotlight/{requirements,design,tasks}.md`
  (authored by a Claude Code session, executed in Kiro, phases 1a–1c merged as PRs #1349/#1352/#1360).
- Kiro steering exists in both repos (`.kiro/steering/*.md`, `inclusion: always` / `fileMatch`); `vitana-kiro-notes.md`
  already tells Kiro to spar through Claude Code / Operator and to run `scripts/dev/resume-vtid.sh`.
- `scripts/ci/kiro-steering/guard.cjs` runs in PR-GATE in both repos (VTID-05059), currently `continue-on-error: true`.
- `scripts/dev/resume-vtid.sh` (VTID-05060) prints a VTID's ledger row, PRs, evidence and handoff notes.
- Gap: a plan Kiro writes and never pushes is invisible (the owner's 28-card plan is not on any branch today).

## Design
### 1. Git is the only channel
A plan, status change, finding or result that is not pushed to `origin` does not exist. No new service, token,
database table or chat bridge. Both agents already have git access to both repos.

### 2. One plan format for both agents: the Kiro spec folder
Every plan, whichever agent writes it, lives in `.kiro/specs/<slug>/` in the repo where most code changes
(cross-repo plans: `vitana-platform`). Files:
- `requirements.md`, `design.md`, `tasks.md` — Kiro's native format (unchanged).
- **new `handoff.md`** — YAML front matter + append-only log:
  ```
  ---
  slug: <slug>
  author: claude | kiro
  executor: claude | kiro
  next_actor: claude | kiro | owner
  state: drafted | sparred | approved | executing | in-review | verified | done | parked
  vtids: [VTID-xxxxx, ...]      # empty until Gate 1 yes
  sparring_record: <path>       # set once sparred
  updated: <ISO date>
  ---
  ## Log
  ### <ISO datetime> · <agent> · <state change>
  What was done · PR/commit links · what next_actor must do next · open questions
  ```
  Existing `desktop-spotlight` gets a `handoff.md` reflecting today's state (1a–1c done; Phase 2 next, executor kiro).

### 3. The queue: computed, never committed (R1 F1)
No committed INDEX.md. `scripts/collab/queue.mjs` (single source in **vitana-platform**, R1 F3) is run by an agent
after `git fetch origin` in each local checkout: `node <platform>/scripts/collab/queue.mjs --repo <path> [--repo <path>]`.
It reads `.kiro/specs/*/handoff.md` **and** `.kiro/specs/*/lanes/*.md` (§9) from `origin/main` and from every
remote branch updated in the last 30 days whose diff vs `origin/main` touches one of them (updates ride in plan/work
PRs and are not on main until merge), plus the `collab-claim/*` refs, and prints **one row per lane** (R4 F11), newest
version by `updated`: slug, lane-id, lane state, lane next_actor, claimed_by session (from the claim ref), dependencies
met / `blocked`, branch, PR, last log line — plus one plan row per slug (plan state, coordinator claim). A spec
without lanes is shown as a single implicit lane `main` backed by `handoff.md` (backward compatible).
`--mine <session-id>` filters to what that session holds. Read-only, no network beyond `git fetch`.
Validation mode `--validate --base <sha> --head <sha>`: enum values, required keys, `vtids` present when
`state ∈ {approved, executing, in-review, verified, done}`, `sparring_record` present when `state ≠ drafted`, and the
state transition between base and head is legal (R1 F4):
`drafted→sparred→approved→executing→in-review→verified→done`; `in-review→executing` (changes requested);
`sparred→drafted` (re-plan); any non-terminal → `parked`; `parked→` the state before parking (read from the log).
`done` is terminal. A new handoff.md may start only at `drafted`, except the one-time backfill (§2) which is allowed
via `--allow-initial=<slug>` in that PR only.

### 4. CI enforcement (PR-GATE, both repos)
New step "Collab handoff" next to "Kiro steering": `queue.mjs --validate --base --head` fails on an invalid
`handoff.md`/lane file, an illegal transition, or a §9 lane/session mismatch, and writes the queue table to the job step summary (readable, never committed).
vitana-platform runs its own copy; vitana-v1 fetches the canonical script at run time with the existing
`PLATFORM_DISPATCH_TOKEN` + `gh api …/contents/scripts/collab/queue.mjs?ref=main` pattern already used for
`staging-guard.ts` (`vitana-v1/.github/workflows/PR-GATE.yml:227-233`) — no second copy to drift (R1 F3). Node `--test` unit tests for the script. Starts as
`continue-on-error: true` (same as the steering guard) for one week, then flipped to blocking in a follow-up
commit under the same VTID if it produced no false positives.

### 5. Session-start + session-end rules (R1 F7: small always-loaded part, details scoped)
- Full rules: `.claude/rules/collaboration.md` (`paths: .kiro/specs/**`) and its required twin
  `.kiro/steering/vitana-collaboration.md` (same `fileMatch`, satisfies the VTID-05059 steering guard) in both repos.
- Always-loaded pointer (≤5 lines): a short section in both `CLAUDE.md` files and 3 lines appended to the existing
  `inclusion: always` `vitana-kiro-notes.md` in both repos: "at session start run the queue; work items where
  next_actor is you; claim before acting; push before ending; details in collaboration.md".
Content (identical meaning):
  1. At session start: `git fetch origin && git pull` on the default branch; run `queue.mjs` over both repos to see the queue.
  2. The unit of work is a **lane** (§9). Pick a lane whose `next_actor` is you and that is not `blocked`, oldest
     `updated` first, unless the owner gave a different task. Generate/state your session id (§9) first.
     **Claim first (R1 F2, R4 F10):** `git push origin <sha>:refs/heads/collab-claim/<slug>/<lane-id>` *without* force
     (the plan-level coordinator role is the pseudo-lane `_plan`, §9). Git refuses
     the push if that ref already exists → another session holds it → skip the item. The claim commit carries the
     agent + session id in its message; the claim branch is deleted when the agent hands off (sets a new
     next_actor). A claim older than 24 h with no new commit on the work branch may be broken by deleting the ref,
     with a log entry saying so (stale-claim rule). This is an atomic compare-and-set on the remote; the
     residual race (a session acting without claiming) is caught by the PR conflict and by the rules text.
  3. Before ending: append a log entry and set `next_actor`/`state` in **your lane file** `lanes/<lane-id>.md`
     (only the `_plan` claim holder writes `handoff.md`), delete your claim ref, commit and **push** (on the
     work branch / PR — never directly to main). A session that cannot push says so to the owner.
  4. Plans written by you go up as a PR `plan(<slug>): …` containing only the spec folder, state `drafted`,
     `next_actor: claude` (Claude Code runs sparring — Kiro has no subagents).
  5. All existing gates unchanged: sparring before VTID, Gate 1 and Gate 2 to the owner, never test against
     production, staging read-only.

### 6. Roles
- **Kiro authors → Claude executes**: Kiro pushes spec (drafted, next_actor claude) → Claude spars it with the
  `plan-sparring-partner` agent, writes the record into the spec folder, sends Gate 1 → on yes allocates VTIDs,
  sets `executing`, implements per `tasks.md`, PR → `in-review`, `next_actor: kiro` → Kiro reviews the PR
  (comment on the PR + log entry) → Claude merges, STAGING-VERIFY, Gate 2 → `done`.
- **Claude authors → Kiro executes**: Claude writes spec, spars, Gate 1 → on yes allocates VTIDs, `approved`,
  `next_actor: kiro` → Kiro implements, PR per phase → `in-review`, `next_actor: claude` → Claude verifies the PR
  against `tasks.md` acceptance + CI, reviews on GitHub, merges, watches STAGING-VERIFY, Gate 2 → `done`.
- Owner is `next_actor` only at Gate 1, Gate 2, and the four Autonomy-Contract stop cases.
- **With lanes (R4 F12)**: the flows above apply **per lane, independently and in parallel** — each lane has its own
  claim, branch, PR, review and `next_actor`. Plan-level steps (sparring, Gate 1, VTID allocation, `approved →
  executing`, `executing → done` once every lane is `done`, Gate 2 for the release) are done by the `_plan` claim
  holder (coordinator, §9).
- Conflict rule: one session owns a lane's code at a time (= its claim). Others only read, or append review
  entries/PR comments.

### 7. Waking Claude without the owner
A cloud Routine (`create_trigger`, fresh session per fire, both repos, schedule: weekdays 3×/day, jittered) whose
prompt is: run the queue over both repos; for every item with `next_actor: claude`, continue it per the rules;
for every open PR labelled `executor:kiro` with no Claude review on its head commit, review it. Housekeeping each fire: delete refs anywhere under `refs/heads/collab-claim/` (any depth, R5 F15) whose
spec is `done`, or whose claim commit is older than 48 h with no work-branch activity (log entry on the spec). If nothing is
queued: end with no output. The prompt text is committed as `scripts/collab/routine-prompt.md` (platform) and
the Routine is created from it; recreating it = one documented `create_trigger` call with that file (R1 F5). No production writes; Gate 1/Gate 2 messages go to the owner as today.
Kiro is a local IDE and cannot be woken remotely: the owner opens it and types "continue"; the steering file makes
Kiro read the queue itself. This is the one remaining human touch point and is stated as such.

### 8. First use
The 28-card plan Kiro already wrote is on no branch today (checked). Independently of this VTID, Kiro can push it now; Kiro pushes it as `.kiro/specs/<slug>/` with `handoff.md`
(`author: kiro`, `next_actor: claude`, `state: drafted`). It then goes through §6 like any other plan.

## Files in scope
vitana-platform only: `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, `scripts/collab/routine-prompt.md` (new)
vitana-v1 and vitana-platform (each):
- `.claude/rules/collaboration.md` + `.kiro/steering/vitana-collaboration.md` (new twins)
- `.kiro/steering/vitana-kiro-notes.md` (3 lines)
- `.github/workflows/PR-GATE.yml` (one new step: handoff + lane/session validation)
- `CLAUDE.md` (≤5-line pointer)
vitana-v1 only: `.kiro/specs/desktop-spotlight/handoff.md` + `lanes/*.md` for its open phases (new)
Outside git: one Routine (create_trigger).

## Test plan
- Unit (`node --test`): valid front matter passes; each invalid enum/missing key fails with a named error;
  every legal transition passes and a table of illegal ones fails; `done` is terminal; newest-`updated` wins across
  branches; empty specs dir → empty queue; claim-ref parsing; lane dependency → `blocked`; a PR touching a
  foreign lane file, a branch/lane mismatch, or `claimed_by` ≠ `Collab-Session` each fail; two lanes of one spec
  validate independently;
  spec folder without handoff.md → listed as `untracked` warning (not failure, so existing folders don't break).
- PR-GATE runs the step green on both PRs.
- Dry run on `desktop-spotlight`: the queue shows Phase 2 with `next_actor: kiro`.
- Routine: one manual `fire_trigger` after merge; expected result is "nothing queued" or the 28-card spec picked up.
- No staging test: nothing deploys (no Gate 2).

### 9. Parallel sessions: lanes and session identity (owner input 2026-10-13, after Gate 1 draft)
Owner: "I will run dozens of Kiro sessions in parallel" (and Claude runs several too). Nothing may be mixed up or
wrongly matched. Unit of work and of addressing is therefore a **lane**, never "kiro" or "claude" in general.
- **Lane** = one independently executable unit of a spec: `<slug>/<lane-id>`, where `lane-id` is a task-group id in
  `tasks.md` (e.g. `phase-2`, `card-07`). `tasks.md` gets a `lane:` marker per task group; the author declares lanes
  and their dependencies when writing the plan. Lanes with unmet dependencies are not claimable (queue shows `blocked`).
- **Per-lane file**: `.kiro/specs/<slug>/lanes/<lane-id>.md` (front matter: `next_actor`, `state` from the **lane** set `ready | executing | in-review | verified | done | parked`
  — transitions `ready→executing→in-review→verified→done`, `in-review→executing`, non-terminal→`parked`→previous;
  plan-only states `drafted/sparred/approved` are rejected in lane files (R5 F14) —
  `vtid`, `branch`, `pr`, `claimed_by`) + its own log. A lane file is written only by the session holding that
  lane's claim (or by the reviewer appending a review entry). `handoff.md` keeps only plan-level state
  (drafted…approved, then `executing` while any lane is open, `done` when all lanes are done) and is written only by
  the plan's coordinator session. Dozens of sessions therefore never write the same file → no conflicts, no mixing.
- **Session identity**: every session has one id, stated in its first reply to the owner and used everywhere:
  Claude = its cloud session id (`session_…`); Kiro = `kiro-<yyyymmddHHMM>-<4 hex>` generated at session start
  (steering rule; the session writes it into its first log entry). Every commit carries trailers
  `Collab-Session: <id>` and `Collab-Lane: <slug>/<lane-id>`; claim commits carry the same.
- **Claim per lane**: `refs/heads/collab-claim/<slug>/<lane-id>` (non-force push, §5) — one session per lane;
  different lanes of the same spec run fully in parallel.
- **Coordinator (R4 F13)** = holder of the pseudo-lane claim `collab-claim/<slug>/_plan`, taken the same atomic way.
  It is the only writer of `handoff.md`. It holds the claim only while doing plan-level steps and releases it after;
  any session may take it later (e.g. to move the plan to `done`). Abandoned → the same 24 h stale-claim rule; the
  Routine also takes `_plan` when every lane is `done` and the plan is not, so a plan never sticks in `executing`.
- **Branch + PR per lane**: branch `<kiro|claude>/<slug>/<lane-id>`, PR title `VTID-xxxxx (<slug>/<lane-id>): …`,
  PR body names the session id. Reviewer matches PR ↔ lane ↔ spec by these keys only — never by recency or
  by "the last thing Kiro did".
- **Validation**: CI fails a PR whose commits touch a lane file other than the one in its `Collab-Lane` trailers,
  whose branch name does not match the lane, or whose lane file `claimed_by` ≠ the commits' `Collab-Session`.
- **Owner talking to a session**: the session's first reply names its session id and lane (or "no lane").
  An owner instruction about a lane held by another session → the session says which session holds it and does
  not touch it; a session without a claim never edits spec or lane files. Kiro session ids are what the owner
  uses to tell parallel Kiro windows apart.
- **One VTID per lane** (or per lane group the plan declares), so ledger rows and PRs never share between sessions.
<!-- plan:end -->

---
## Planner responses — round 1
- F1 major (committed INDEX.md conflicts) — **ACCEPTED**: no committed index; queue computed from origin/main + recent remote branches; CI step summary only (§3, §4).
- F2 major (race on next_actor) — **ACCEPTED**: atomic claim via non-force push of `refs/heads/collab-claim/<slug>`, stale-claim rule (§5.2). Not the ledger `claimed_by`: that field feeds the worker-runner eligibility predicate (platform CLAUDE.md §4 criterion 4) and reusing it for sessions is exactly the VTID-03516 failure shape.
- F3 major (byte-identical copies) — **ACCEPTED**: one canonical script in vitana-platform; v1 CI fetches it with the existing staging-guard pattern (§4).
- F4 minor (no transitions) — **ACCEPTED**: transition table validated base→head in CI (§3).
- F5 minor (Routine not versioned) — **ACCEPTED**: `scripts/collab/routine-prompt.md` committed (§7).
- F6 minor (overstated goal) — **ACCEPTED**: goal restated (Goal).
- F7 minor (CLAUDE.md growth) — **ACCEPTED**: scoped rules file + twin; ≤5-line always-loaded pointer (§5).
- Q1: concurrency unknown → designed for many concurrent specs (F1/F2 fixes). Q2: the 28-card plan is on no branch; Kiro can push it as a plain plan PR today; it becomes the first item the queue shows. Q3: both the Routine and ad-hoc sessions may pick items up → the claim ref covers both.

## Planner responses — round 2
- F8 major (stale INDEX.md text in §5) — **ACCEPTED**: oversight; §5.1 now runs `queue.mjs`, §5.3 updates `handoff.md` and deletes the claim ref. No INDEX.md exists anywhere.
- F9 minor (orphan claim refs) — **ACCEPTED**: Routine housekeeping step added (§7).
- Q1: oversight, no local INDEX.md.

## Round 4 — owner-directed change (parallel sessions, §9)
Owner input after the Gate 1 draft: dozens of parallel Kiro sessions (and several Claude sessions) must never be
mixed up or wrongly matched. Added §9 (lanes, per-lane files, session ids, commit trailers, per-lane claims,
branch/PR naming, CI validation). Single round with the same partner per skill §6.

## Planner responses — round 4
- F10 major (§5 still spec-level) — **ACCEPTED**: §5.2/§5.3 now lane-level claim ref and lane file; `_plan` for coordinator.
- F11 major (queue spec-level) — **ACCEPTED**: §3 reads lane files + claim refs, one row per lane, `blocked`, `--mine`; lane-less spec = implicit lane `main`.
- F12 minor (roles serial) — **ACCEPTED**: §6 per-lane paragraph.
- F13 minor (coordinator undefined) — **ACCEPTED**: coordinator = holder of `collab-claim/<slug>/_plan` (atomic, same stale rule; Routine takes it to finish a plan). Chosen over "next session becomes coordinator" because that rule is itself racy with dozens of sessions.

## Planner responses — round 5
- F14 minor (lane states) — **ACCEPTED**: separate lane state set + transition table; plan-only states rejected in lane files.
- F15 minor (glob depth) — **ACCEPTED**: housekeeping covers any depth under `refs/heads/collab-claim/`.
Verdict after round 5: CONVERGED (partner). Both minors applied in the final plan text.
