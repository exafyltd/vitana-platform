# Delivery capacity: seats, sessions, identities and the 13-account target

- **Status:** Discovery only. Every statement below carries its own status class. No seat, account, automation,
  variable or rule file is changed by this document.
- **Owner:** Project owner (account roster, strategy decision DEC-057).
- **Pinned HEAD:** `exafyltd/vitana-platform` `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835` (origin/main, last commit
  2026-11-08T19:27+01:00); `exafyltd/vitana-v1` `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f` (origin/main). Every
  `path:line` citation resolves at these commits (check in `docs/validation/VTID-05688/commands.log`).
- **VTID:** VTID-05688 (lane `strategy-execution-wave1/delivery-capacity`).
- **Plan:** `.kiro/specs/strategy-execution-wave1/plan.md` §4 item 4 (plan PR
  [#4942](https://github.com/exafyltd/vitana-platform/pull/4942), converged and approved by policy `converged-auto-v1`).
- **Reuses:** strategy repo `vitanaland-strategy/19-EXECUTION-PROGRAMME/DELIVERY-ACCOUNTS-AND-COORDINATION.md` and
  evidence EV-089 (`vitanaland-strategy/11-EVIDENCE/evidence-register.md:93`), strategy commit `fb77090e1f`. Re-checked
  here; corrections in section 7.

Status classes used: **Verified operational** (only with a run id), **Verified implemented, not operational**,
**Implemented but incomplete**, **Designed but not implemented**, **Deprecated/superseded**, **Unknown**.

Rules for this document: seat names and GitHub or GitLab login names only. No e-mail address is reproduced, including
the account values in `areas.yaml`. "Activity evidenced" means a commit with that session's `Collab-Session` trailer
exists; it never means "available now".

## 1. Seats (configuration)

`docs/programs/areas.yaml:14-18` lists four seats. Each has an account value (not reproduced), a surface and, for Kiro
Web seats, an automation file. Status: Verified implemented, not operational (configuration).

| Seat | Surface | Automation file | Areas owned (`docs/programs/areas.yaml:20-52`) | Other role |
|---|---|---|---|---|
| `jtadic` | kiro-web | `.kiro/automations/jtadic.md` | `backoffice` | none |
| `exafyltd` | kiro-web | `.kiro/automations/exafyltd.md` | `messenger`, `frontend` (catch-all) | exceptions seat (`docs/programs/areas.yaml:12`); takes Claude work while Claude is unavailable (`.claude/rules/collaboration.md:219-228`) |
| `hotmail` | kiro-ide | none (Kiro IDE has no automation) | none | its key also runs the server-side Kiro runner (`docs/programs/areas.yaml:17`) |
| `exafy` | kiro-web | `.kiro/automations/exafy.md` | `platform` (`docs/programs/areas.yaml:39-47`) | none |

Seat names are 1 to 12 lowercase letters (`docs/programs/areas.yaml:9`, `.claude/rules/collaboration.md:121-124`). All
Kiro accounts share one GitHub identity, so each account pulls its own work instead of being addressed on GitHub
(`.claude/rules/collaboration.md:118-120`).

## 2. Sessions seen in git

### 2.1 Commit trailers on `main`, 2026-10-12 to the pin

Command: `git log --since=2026-10-12 --format=%B origin/main | grep Collab-Session`, then distinct values grouped by
prefix (full commands in `commands.log`). vitana-platform: 3,352 trailer lines, 361 distinct session ids.

| Prefix | Distinct sessions (platform) | Distinct sessions (v1) | First and last trailer (platform) | Latest commit (platform) | Status |
|---|---|---|---|---|---|
| `kiro-exafyltd-` | 50 | 16 | 2026-10-16 to 2026-11-08 | `c43ddcf1d4` | Activity evidenced |
| `kiro-exafy-` | 37 | 2 | 2026-10-18 to 2026-11-08 | `e8a7eb0e4f` | Activity evidenced |
| `kiro-hotmail-` | 13 | 4 | 2026-10-20 to 2026-11-08 | `3e45c479bc` | Activity evidenced |
| `kiro-jtadic-` | 10 | 2 | 2026-10-20 to 2026-11-05 | `cd1e8e306b` | Activity evidenced |
| `kiro-dstev-` | 1 | 0 | 2026-10-28 to 2026-11-01 | `62990ce285` | Activity evidenced; seat `dstev` is not in `areas.yaml` |
| `kiro-<timestamp>` (no seat in the id) | 22 | 7 | 2026-10-16 to 2026-11-02 | `ed43ba6362` | Activity evidenced; account Unknown |
| `kiro-ide-…` | 2 | 2 | 2026-10-24 to 2026-10-28 | `02b45df866` | Activity evidenced; account Unknown |
| Claude Code `session_…` | 12 | 7 | 2026-10-13 to 2026-11-08 | `2daf4efef2` | Activity evidenced (section 4) |
| `agent-vitana-lane-reviewer-…` | 212 | 1 | 2026-10-21 to 2026-11-08 | `f016c1da9b` | Reviewer agent runs inside a calling session; not an account |
| `pm-agent` | 1 | 0 | 2026-10-20 to 2026-11-05 | `945755f084` | Project Manager bookkeeping commits; not an account |
| `ci-plan-spar` | 1 | 0 | 2026-10-18 to 2026-11-08 | `690214d259` | CI bot; not an account |

vitana-platform `main` has no commit after 2026-11-08T19:27+01:00; the strategy evidence records that GitHub `main` has
been frozen since 2026-11-08/09 (EV-088, `vitanaland-strategy/11-EVIDENCE/evidence-register.md:92`). The 30-day window
is therefore about 27 days of real activity.

### 2.2 After the pin (open pull requests, `gh api` GET, read 2026-11-11)

Head commits of PRs updated on or after 2026-11-09 carry these Kiro sessions: `kiro-exafyltd-202611072144-1c88`
(vitana-platform #4917 to #4940 and vitana-v1 #1608 to #1658, latest 2026-11-10T18:51Z), `kiro-hotmail-202611061752-cc1f`
(vitana-platform #4920 to #4935, latest 2026-11-10T10:36Z) and `kiro-exafy-202611110004-e38b` (this plan, #4942,
2026-11-11T00:25Z). No `kiro-jtadic-` and no Claude `session_` head commit was found in that set.

### 2.3 Lane logs, claim refs and driver heartbeats

| Source | Finding | Status |
|---|---|---|
| Lane and handoff log headings `### <time> · <session> · …` dated 2026-10-12 or later, in `.kiro/specs/*/` at the pin | 355 distinct sessions: 218 reviewer agent, 48 `kiro-exafyltd`, 36 `kiro-exafy`, 15 `kiro-hotmail`, 13 without seat, 11 `kiro-jtadic`, 7 Claude, 1 each `kiro-dstev`, `kiro-ide`, `pm-agent`, `ci-plan-spar` and three placeholder or malformed ids | Verified implemented, not operational (git state) |
| Plan authors (`author_seat` in `handoff.md`) | `exafyltd` 48, `hotmail` 27, `exafy` 15, `jtadic` 12, `dstev` 1 | Verified implemented, not operational |
| Claim refs `refs/heads/collab-claim/*` | 271 in vitana-platform, 27 in vitana-v1 | Verified implemented, not operational |
| Driver heartbeats `refs/heads/collab-driver/*` | 49 in vitana-platform, 4 in vitana-v1. Session of the tip commit: `exafyltd` 19, `hotmail` 17, `exafy` 12, `jtadic` 4, none 1. Newest tip 2026-11-08T16:26Z, so no driver was alive (younger than 45 min, `.claude/rules/collaboration.md:333-337`) at the read time 2026-11-11T00:32Z | Verified implemented, not operational; liveness: none alive |

### 2.4 Open work by seat (lane files on `main` at the pin)

393 lane files; 87 `done`. Lanes in `ready`, `executing` or `in-review`: `exafyltd` 148, `jtadic` 57, `exafy` 54,
`hotmail` 4, no seat 17, seat `claude` 1. Lanes not `done` with `next_actor: claude`: 12 (5 executing, 1 in-review,
4 ready, 2 parked). Many `ready` lanes may be stale; this count is the recorded state, not a measured backlog.

## 3. Identities

### 3.1 GitHub commit authors on vitana-platform `main`, 2026-10-12 to the pin

| Author name | Commits | What it is |
|---|---|---|
| `exafyltd` | 305 (plus 3 under a second, noreply address) | Squash merges of PRs; the shared GitHub identity of the Kiro accounts (`.claude/rules/collaboration.md:119`) |
| `kiro-agent[bot]` | 221 (plus 1 under a second address) | Kiro lane commits (identity required by `.kiro/pipeline/common-rules.md:49-51`) |
| `vitanaland-code` | 123 (under two distinct addresses) | Unknown mapping to a seat |
| `Claude` | 18 | Claude Code session commits |
| `plan-spar[bot]` | 8 | CI PLAN-SPAR |
| `DraganAlex99`, `DraganOffice`, `dstevanovic-jpg` | 6, 5, 4 | Human GitHub accounts; not delivery seats |
| `Kiro Agent` | 2 | Older Kiro bot identity |
| `github-actions[bot]` | 1 | CI |

Because all Kiro accounts commit as `kiro-agent[bot]` and merge as `exafyltd`, the commit author never identifies the
seat. Only the `Collab-Session` trailer does.

### 3.2 GitLab identities (from strategy evidence, not re-read)

EV-089 records a GitLab group member list read on 2026-11-10: `agent-kiro-exafy`, `agent-kiro-exafyltd`,
`agent-kiro-jtadic`, `agent-kiro-hotmail`, `claude-agent`, `DraganExafy` (Maintainer) and `root`
(`vitanaland-strategy/11-EVIDENCE/evidence-register.md:93`). This lane did not call GitLab. Status: Unknown at the read
time of this document; the four `agent-kiro-*` logins match the four seats by name only.

## 4. Claude Code status

| Source | What it says | Evidence | Status |
|---|---|---|---|
| vitana-platform `CLAUDE.md` | "(Claude Code is retired)" in the protected-gate sentence | `CLAUDE.md:83` | Deprecated/superseded by collaboration.md (below) |
| vitana-v1 `CLAUDE.md` | same sentence | `vitana-v1/CLAUDE.md:108` | same |
| Steering and runbook copies | same sentence | `.kiro/steering/vitana-owner-autonomy.md:42`, `.kiro/pipeline/common-rules.md:25` | same |
| `.claude/rules/collaboration.md` | Claude Code is optional; handles exceptions when available; the "retired" wording was removed by VTID-05566 ("Claude Code may build lanes again", merged 2026-11-06 as `7fd4106862` on the owner's named instruction) | `.claude/rules/collaboration.md:174-176`, `.claude/rules/collaboration.md:217-218` | Verified implemented, not operational |
| Claude unavailable mode | Unavailable when repository variable `CLAUDE_AVAILABLE` is the literal `false`, or when the oldest open `next_actor: claude` item is older than 4 h with no newer `session_…` commit; then the exceptions seat `exafyltd` takes the work | `.claude/rules/collaboration.md:219-228` | Verified implemented, not operational |
| `CLAUDE_AVAILABLE` value | `gh api repos/exafyltd/vitana-platform/actions/variables/CLAUDE_AVAILABLE` answered HTTP 403 to this session | `commands.log` | Unknown |
| 4 h rule | 12 lanes wait on `next_actor: claude` (section 2.4); the newest Claude commit on `main` is `2daf4efef2` (2026-11-08T10:51+01:00), and no Claude head commit was found on PRs updated since 2026-11-09 | sections 2.1, 2.2 | Unknown (not computed per item); the evidence points to "unavailable by the 4 h rule" at read time |
| Activity | 12 distinct Claude sessions in platform trailers and 7 in v1 between 2026-10-13 and 2026-11-08; 18 commits authored `Claude` | section 2.1, 3.1 | Activity evidenced until 2026-11-08 |

The rule text is inconsistent: `CLAUDE.md` says retired, collaboration.md (the source of truth for roles,
`CLAUDE.md:76-84`) says optional, and git shows Claude Code sessions committing until 2026-11-08.

## 5. Capacity against the target

The owner's target is 12 Kiro accounts and 1 Claude Code account (plan §2; strategy DEC-057,
`vitanaland-strategy/09-DECISIONS/unresolved-decisions.md:61`).

| Slot | Target | Evidenced | Basis | Gap |
|---|---|---|---|---|
| Kiro seats configured | 12 | 4 (`jtadic`, `exafyltd`, `hotmail`, `exafy`) | `docs/programs/areas.yaml:14-18` | 8 seats have no name, account, area or automation |
| Kiro seats with activity in the window | 12 | 4 configured seats plus `dstev` (1 session, not configured) | section 2.1 | `dstev` needs a decision: register it as a seat or treat it as a one-off |
| Kiro seats with activity after the pin (2026-11-09 to 2026-11-11) | 12 | 3 (`exafyltd`, `hotmail`, `exafy`) | section 2.2 | `jtadic` last evidenced 2026-11-05 (status Unknown since) |
| Kiro Web automations | one per Kiro Web seat | 3 (`jtadic`, `exafyltd`, `exafy`) | `.kiro/automations/` | `hotmail` is Kiro IDE and has none by design; it wakes only when started |
| Claude Code | 1 | sessions until 2026-11-08; availability Unknown | section 4 | rule text conflict; variable unreadable |
| Live plan drivers | as many as approved plans | 0 alive at read time | section 2.3 | every plan waits for a session or automation to start its driver |

Available capacity as evidenced: **4 Kiro seats** configured, of which **3** show activity after 2026-11-08; **0 or 1
Claude Code** (Unknown); the reviewer agent and PLAN-SPAR are tools inside sessions and CI, not extra capacity. Against
the 13-account target that is 4 of 13 configured, 3 of 13 evidenced in the last two days. The open lane queue (section
2.4) sits mostly on `exafyltd` (148) and `jtadic` (57), so the load is uneven as well as short.

Gaps, in order:
1. Eight Kiro identities do not exist in any repository file. Only the owner can supply them (DEC-057).
2. Claude Code status is stated three ways (retired, optional, active until 2026-11-08) and the switch variable cannot
   be read by a Kiro session.
3. `dstev` and the seatless `kiro-<timestamp>` and `kiro-ide-…` sessions cannot be tied to an account.
4. `exafyltd` is the exceptions seat, the catch-all frontend seat and the messenger seat, and holds 148 open lanes.
5. GitLab logins exist for four Kiro seats and `claude-agent` only (EV-089, not re-read).

## 6. Proposed wording for the owner (text only; these files are not edited by this lane)

`CLAUDE.md` is a protected gate file (`.claude/rules/collaboration.md:139-144`) and `docs/programs/areas.yaml` is a
governance path (`.claude/rules/collaboration.md:136`). Each change below needs its own sparred plan and, for
`CLAUDE.md`, the owner's instruction naming that plan plus a reviewer-agent accept.

**P1. vitana-platform `CLAUDE.md:83`** (and the same sentence in `vitana-v1/CLAUDE.md:108`). Current:

> … it needs the owner's instruction naming the plan plus a reviewer-agent accept on the current head (Claude Code is
> retired).

Proposed (matches collaboration.md after VTID-05566):

> … it needs the owner's instruction naming the plan plus a reviewer-agent accept on the current head. Claude Code is
> optional: it works only when available (`CLAUDE_AVAILABLE` and the 4 h rule, `.claude/rules/collaboration.md` §7).

**P2. vitana-platform `CLAUDE.md`, collaboration paragraph** (after the sentence ending "Full rules:
`.claude/rules/collaboration.md`."), add:

> Delivery capacity is the Kiro seats listed in `docs/programs/areas.yaml` (one Kiro account each) plus Claude Code when
> available. The owner's target is 12 Kiro seats and 1 Claude Code account; a seat that is not in `areas.yaml` does not
> exist for lane assignment.

**P3. `docs/programs/areas.yaml`**, header comment after line 9, add (comment only, so no parser change):

> `# Target roster (owner, DEC-057): 12 Kiro seats + 1 Claude Code account. Seats 5-12 are added here by the owner with`
> `# name, account, surface and automation; until then lanes for them stay unassigned. Claude Code is not a seat: its`
> `# availability is CLAUDE_AVAILABLE plus the 4 h rule (.claude/rules/collaboration.md §7).`

**P4. `docs/programs/areas.yaml`, seat `dstev`** (only if the owner confirms it is a separate Kiro account): one line
in the `seats:` map with its surface and account, and an automation file if it is Kiro Web. Without that confirmation,
no change.

## 7. Corrections to the strategy document

- The strategy document quotes `CLAUDE.md:83` "Claude Code is retired" as the rule. collaboration.md no longer says it
  (VTID-05566, 2026-11-06), and Claude Code sessions committed until 2026-11-08 (section 4).
- The strategy document lists `dstev` from one handoff file. Git shows one `kiro-dstev-` session with commits from
  2026-10-28 to 2026-11-01 and one plan authored (section 2.1, 2.3).
- The strategy document gives no session counts; section 2 adds them.

## 8. Proposed follow-ups

| # | Title | Files | Risk | Owner | Gate |
|---|---|---|---|---|---|
| C1 | Supply seats 5 to 12 | `docs/programs/areas.yaml`, `.kiro/automations/<seat>.md` | Low (governance path) | Project owner | owner supplies identities; sparred plan |
| C2 | Remove "Claude Code is retired" (P1, P2) | `CLAUDE.md` both repos, `.kiro/steering/vitana-owner-autonomy.md` both repos, `.kiro/pipeline/common-rules.md` | Low; protected gate file | Project owner | sparred plan; owner instruction naming it |
| C3 | Make `CLAUDE_AVAILABLE` readable to the delivery seats, or publish its value in git | repository variable access or a status file | Low | Project owner | owner decision (permission change, outside this plan) |
| C4 | Decide `dstev` (P4) | `docs/programs/areas.yaml` | Low | Project owner | owner confirmation |
| C5 | Rebalance the `exafyltd` load (area map) once new seats exist | `docs/programs/areas.yaml` | Medium: changes lane assignment | Delivery owner | sparred plan after C1 |
| C6 | Stale lane sweep (221 `ready` lanes) | lane files via `_plan` claims | Medium | Delivery owner | per-plan driver; no new mechanism |

## 9. Unchanged

`CLAUDE.md`, `docs/programs/areas.yaml`, automations, repository variables, GitLab membership and every lane file. No
account was created, renamed or reported available without a commit that shows it.
