# Plan sparring record — VTID-05194 (VTID-05145 amendment A1: Kiro Web automations, seats, areas)

- Partner: plan-sparring-partner, the same partner that sparred VTID-05145 (rounds R1–R5); amendment round per skill §6
- Class: light/standard boundary (docs, rules, one CI script + tests); nothing deploys → no Gate 2
- Plan hash (sha256 of text between plan markers): f45cc29e9a7e67b0f31d9373d7b2fa41316a1491b8e8a7cb198ae3fbe0cf5b5f
- Verdict: **CONVERGED** (F21–F23 minor, all ACCEPTED; no blocker/major)
- Owner approval: chat 2026-10-14 — area split agreed; role change agreed; "3 yes do it" (Kiro Web automations)
- Parent: VTID-05145

## Plan and round (verbatim)

# VTID-05145 amendment A1 — Kiro Web scheduled automations, seats and areas

<!-- plan:begin -->
## Why (owner decisions 2026-10-14, this conversation)
Owner: Kiro accounts are the capacity (separate credits, same Opus model), Claude only coordinates. Four Kiro
accounts: Kiro IDE `d.stevanovic@exafy.io`, `dstevanovic@hotmail.com`; Kiro Web `j.tadic@exafy.io`,
`exafyltd@gmail.com`. All share ONE GitHub identity (`exafyltd`), so GitHub label / `/kiro` triggers cannot address one
account. Owner-approved area split: j.tadic → backoffice automation; exafyltd → chat/messenger + general frontend.
Kiro Web has scheduled Automations (repos + task + up to 5 cron schedules; each run = isolated cloud sandbox that clones
the repos and opens a PR; kiro.dev/docs/web/automations). Owner said "yes do it" to: one automation per Kiro Web
account that pulls its own lanes from the queue; instructions live in git; the owner's "load the project rules"
steering file is committed so every Kiro account loads it.

## Scope (this amendment; extends VTID-05145, same protocol)
1. **Seats and areas.** Lane front matter gains optional `seat` (`[a-z]{1,12}`, letters only, e.g. `jtadic`, `exafyltd`,
   `hotmail`, `exafy`) and optional `area`. New `vitana-platform/docs/programs/areas.yaml`: area → seat → path
   globs (backoffice: `src/pages/backoffice/**`, `src/components/backoffice/**`,
   `services/gateway/src/routes/backoffice-*.ts`, `services/gateway/src/services/backoffice/**`,
   `services/gateway/src/services/backoffice-*.ts`; messenger: `src/pages/messages/**`, `src/components/messages/**`,
   `src/components/NewConversationPopup.tsx`, `services/gateway/src/routes/chat*.ts`,
   `services/gateway/src/services/chat/**`, `services/gateway/src/services/chat-*.ts`; frontend (exafyltd, lowest
   priority): `src/**` in vitana-v1). Whoever creates a Kiro lane (today the Claude coordinator holding `_plan`) sets
   `seat` from this map; a lane without `seat` is for Kiro IDE / any Kiro session as today.
2. **Seat-scoped session ids.** `queue.mjs session-id --agent kiro [--seat <seat>]` → `kiro-<seat>-YYYYMMDDHHMM-xxxx`;
   `SESSION_RE` becomes `^(session_[A-Za-z0-9]+|kiro-(?:[a-z]{1,12}-)?\d{12}-[0-9a-f]{4})$` (seat letters only, so it can
   never be confused with the 12-digit stamp; old form stays valid). Validator checks `seat` format. `queue` rows show
   `seat`; new filter `--seat <seat>` (lanes with that seat).
3. **Automation instructions in git:** `vitana-platform/.kiro/automations/jtadic.md` and `exafyltd.md`. The Kiro Web
   automation task text is only "Read .kiro/automations/<seat>.md in vitana-platform and follow it exactly." Each file:
   locate the two checkouts (the sandbox's clone directories — find each by `git remote get-url origin`, never assume a path); load the project rules; session id with `--seat`; fetch; queue `--seat <seat>`; take **one** lane: `seat` = me,
   `next_actor: kiro`, state `ready|executing`, not blocked, not claimed, oldest first; claim it (if the sandbox cannot
   push a claim ref, record "claim unavailable" in the lane log and continue — the seat field already makes the lane
   exclusive to this automation); implement only that lane; local checks; commit with `Collab-Session`/`Collab-Lane`
   trailers; push `kiro/<slug>/<lane>`; open/update the PR; lane file → `in-review`, `next_actor: claude`, pr, log entry;
   release the claim; stop. **No lane → stop immediately, no branch, no PR.** Never touch another seat's lane, never
   merge/deploy/allocate/write live systems (§7a). Exactly one lane per run.
4. **Steering:** `.kiro/steering/vitana-load-project-rules.md` (owner-provided text, `inclusion: always`) in both repos.
5. **Rules:** `.claude/rules/collaboration.md` (both repos, identical) gains §3a "Seats, areas and Kiro Web automations"
   (the above) — roles text (§7) unchanged in this amendment; the owner-approved role rebalance (Kiro plans/reviews, PM
   merges) is implemented by the Project Manager plan, not here.
6. Owner setup after merge (documented in the automation files): in app.kiro.dev per account → Automations → New →
   both repos → hourly on weekdays → the one-line task; enable.

## Not in scope
PM agent, auto-merge, cross-account review, lane-path CI enforcement, read-only credentials — all in the PM plan.

## Files
vitana-platform: `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, `docs/programs/areas.yaml`,
`.kiro/automations/{jtadic,exafyltd}.md`, `.kiro/steering/vitana-load-project-rules.md`, `.claude/rules/collaboration.md`,
`docs/validation/VTID-05145/**`. vitana-v1: `.kiro/steering/vitana-load-project-rules.md`, `.claude/rules/collaboration.md`.
Nothing deploys.

## Tests
Unit: seat session id format and generation; old ids still valid; `seat` validation; `--seat` filter; trailers with a
seat session id validate. CI: PR-GATE collab + kiro-steering guard green in both repos.
<!-- plan:end -->

---
## Sparring — amendment round (same partner as VTID-05145 R1–R3)
- F21 minor (plan says `[a-z0-9]`, code `[a-z]`) — ACCEPTED: plan text fixed to letters only.
- F22 minor (seat `dstevanovic` vs `exafy`) — ACCEPTED: plan text fixed to `exafy`.
- F23 minor (hard-coded checkout paths in the Kiro Web sandbox) — ACCEPTED: automation files tell Kiro to locate both checkouts by `git remote get-url origin` and use those paths.
Verdict: CONVERGED (partner, no blocker/major).
