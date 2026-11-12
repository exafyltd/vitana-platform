---
change_class: standard
---
# plan(kiro-fleet-register): record the owner's 12-slot Kiro account fleet in areas.yaml (slot numbers, three new seats, five reserved slots), no email, no permission change
Author: Kiro, seat `exafy`, session `kiro-exafy-202611110920-270b` (Kiro Web). Repo `exafyltd/vitana-platform`.
Premises pinned to `origin/main` vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`.
<!-- plan:begin -->
Pin: vitana-platform `9fe59941dad374767764ae4def71646c312890d8`.

## 1. Goal
Owner, 2026-11-11 ("Execution Directive Update — Kiro Account Fleet", §1): *"These are separately identified Kiro login
accounts. Do not collapse them into one 'exafy', 'exafyltd' or other generic identity."* *"Map each existing seat to its
exact login email [...] Register the six newly identified email accounts that are not already represented. Preserve
Kiro 7–11 as pending slots."* *"The account inventory must be maintained in the existing authoritative
collaboration/account configuration, not in a newly invented account database."* *"Do not change permissions or share
credentials between accounts without approval."* A later owner roster the same day named Kiro 7 and Kiro 8 as accounts
("Kiro 7 … ExafyAdmin, Kiro 8 … ExafyTasks"), which supersedes "preserve Kiro 7–11 as pending" for those two: they
become seats `admin` and `tasks` with `surface: pending`; only Kiro 9–11 stay pending, in the comment block.

The owner's list numbers twelve slots: Kiro 1 is seat `hotmail`, Kiro 2 `exafy`, Kiro 3 `exafyltd`, Kiro 12 `jtadic`;
Kiro 4 to 8 are further accounts the owner named (no seat yet; the owner's roster of 2026-11-11 with each account's
name, email and username is kept in the GitLab strategy repository, `19-EXECUTION-PROGRAMME/DELIVERY-ACCOUNTS-AND-COORDINATION.md` §1,
not here); Kiro 9–11 are pending.

Owner, 2026-11-11, to Kiro 3 (plan `privacy-ledger-auth`, `.kiro/specs/privacy-ledger-auth/plan.md:10-12` on branch
`kiro/privacy-ledger-auth/plan`): *"remove the account emails from docs/programs/areas.yaml [...] Do not copy emails into
any plan, PR body, commit message or log."* So this plan stores no email address anywhere: the account-to-seat mapping by
email stays with the owner; the repository holds seat names and slot numbers only.

## 2. Today (evidence)
- The authoritative seat map is `docs/programs/areas.yaml:14-18` (four seats: `jtadic`, `exafyltd`, `hotmail`, `exafy`).
  Lane `privacy-ledger-auth/areas-emails` (VTID-05699, PR #4961) removes their `account:` values. Seat names are 1-12
  lowercase letters (`:9`); a seat is read by `scripts/collab/queue.mjs` `loadSeats` (`:1187-1197`, keys only) and by
  `scripts/collab/automations.test.mjs:17-35` (`{ key: value, … }` on one line; every `automation` file must exist and be
  named after the seat, `:59-68`; the exceptions seat must be `kiro-web`, `:70-76`).
- So four of the owner's twelve slots are already seats (Kiro 1 = `hotmail`, Kiro 2 = `exafy`, Kiro 3 = `exafyltd`,
  Kiro 12 = `jtadic`); Kiro 4 to 8 are not.
- The account emails are already gone from `areas.yaml` on `main` and `scripts/collab/areas-no-email.test.mjs` is on
  `main`, so the start condition below is met.
- Each existing seat has a GitLab user `agent-kiro-<seat>` (`infra/gitlab-engineering/settings/gitlab-settings.json:36,43,50,57`);
  creating GitLab users or tokens for new seats is a credential change and is not part of this plan.
- A lane's `seat` must name a seat of `areas.yaml` (`queue.mjs:1210`), so a new account cannot be given lanes until it is a seat.

## 3. Interfaces
One lane. It edits `docs/programs/areas.yaml` only (a governance path, `queue.mjs:86-87`; not a protected gate file,
`scripts/collab/protected-gate-files.json`). No automation file, no area, no GitLab account, no token, no workflow.

## 4. Lanes
### Lane `seats` (seat `exafy`, governance path → `reviewer_seat: agent:vitana-lane-reviewer`)
Built after VTID-05699 is on `main` (it edits the same seat lines; sequenced, not parallel). Edits on top of that file:
- Add `kiro: <n>` (the owner's slot number) to each existing seat: `hotmail` 1, `exafy` 2, `exafyltd` 3, `jtadic` 12.
- Add five seats, no `account`, no `automation`, no area: `vitanaland` (`kiro: 4`), `office` (`kiro: 5`), `support`
  (`kiro: 6`), `admin` (`kiro: 7`), `tasks` (`kiro: 8`), each with `surface: pending` until the account's first session records its surface. Every seat line,
  new and existing, keeps the one-line inline form `  <seat>: { key: value, … }` (e.g. `  vitanaland: { surface: pending, kiro: 4 }`),
  because `automations.test.mjs:30` parses only that form while `queue.mjs:1194` reads any `  <seat>:` key.
- Add a comment block, indented two spaces inside `seats:` (e.g. `  # Kiro 9–11: reserved …`) so `loadSeats`
  (`queue.mjs:1193`, which ends the block at any column-0 line) and `automations.test.mjs:23` (which skips comments)
  both keep reading seats added below it, listing slots 9–11 as reserved (no seat until the owner names the account),
  and the rule that an account is a login, a seat is its configured identity, a session is one execution context;
  two seats run by one operator are two accounts, not two independent agents unless their sessions are.
- Keep the no-email test of VTID-05699 (`scripts/collab/areas-no-email.test.mjs`) green. Start condition: the lane begins
  only when that file is on `main` (lane `privacy-ledger-auth/areas-emails` merged); before that the lane stays `ready`
  and is not claimed, so the test it depends on always exists when it runs.
- `docs/validation/<VTID>/`: `acceptance.md`, `commands.log`, `scope.json`, the before/after seat table (no email).

Paths: `docs/programs/areas.yaml`, `docs/validation/VTID-*/**`.

Lane identity: this plan's lane is `.kiro/specs/kiro-fleet-register/lanes/seats.md` (key `kiro-fleet-register/seats`,
`seat: exafy`). It is not the lane `agentic-delivery-v2/seats` (`seat: exafyltd`, NATO-alphabet automation paths);
`queue.mjs:185-191` (`classifyPath`) keys every lane by `<slug>/<lane>`, and scope-check reads the trusted front
matter of this plan's own lane file, so that other lane's `seat` and `paths` never apply here.

## 5. Parallel / hot files
Single lane, sequenced after `privacy-ledger-auth/areas-emails` (VTID-05699): both edit `docs/programs/areas.yaml`, so
this lane starts from the `main` that contains VTID-05699. The edit adds keys and lines only (no seat renamed or removed).

## 6. Tests and commands
`node --test scripts/collab/automations.test.mjs scripts/collab/queue.test.mjs scripts/collab/areas-no-email.test.mjs`,
`node scripts/collab/queue.mjs validate` via preflight, a check that `loadSeats` returns the nine seats.

## 7. Measurement
Nine seats, each with `kiro:` and no `account:`; slots 9–11 listed as reserved; tests green.

## 8. Risks
- A seat without `automation` is never woken by a Kiro Web automation; its lanes are built only when its account runs a
  session. Intended until each account is verified.
- No email in the repository: the lane, its evidence and its commits name seats and slots only; the no-email test
  of VTID-05699 guards `areas.yaml`.

## 9. Unchanged
Areas and their seats, `exceptions_seat`, automation files, GitLab users and tokens, repository permissions, CLAUDE.md.
<!-- plan:end -->
