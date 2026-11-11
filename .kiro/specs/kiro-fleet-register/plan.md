---
change_class: standard
---
# plan(kiro-fleet-register): record the owner's 12-slot Kiro account fleet in areas.yaml (slot numbers, three new seats, five reserved slots), no permission change
Author: Kiro, seat `exafy`, session `kiro-exafy-202611110920-270b` (Kiro Web). Repo `exafyltd/vitana-platform`.
Premises pinned to `origin/main` vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`.
<!-- plan:begin -->
Pin: vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`.

## 1. Goal
Owner, 2026-11-11 ("Execution Directive Update — Kiro Account Fleet", §1): *"These are separately identified Kiro login
accounts. Do not collapse them into one 'exafy', 'exafyltd' or other generic identity."* *"Map each existing seat to its
exact login email [...] Register the six newly identified email accounts that are not already represented. Preserve
Kiro 7–11 as pending slots."* *"The account inventory must be maintained in the existing authoritative
collaboration/account configuration, not in a newly invented account database."* *"Do not change permissions or share
credentials between accounts without approval."*

Owner's list: Kiro 1 `dstevanovic@hotmail.com`, Kiro 2 `d.stevanovic@exafy.io`, Kiro 3 `exafyltd@gmail.com`, Kiro 4
`d.stevanovic@vitanaland.com`, Kiro 5 `office@exafy.io`, Kiro 6 `support@exafy.io`, Kiro 7–11 pending, Kiro 12
`j.tadic@exafy.io`.

## 2. Today (evidence)
- The authoritative seat map is `docs/programs/areas.yaml:14-18` (four seats: `jtadic` j.tadic@exafy.io, `exafyltd`
  exafyltd@gmail.com, `hotmail` dstevanovic@hotmail.com, `exafy` d.stevanovic@exafy.io). Seat names are 1-12 lowercase
  letters (`:9`); a seat is read by `scripts/collab/queue.mjs` `loadSeats` (`:1187-1197`, keys only) and by
  `scripts/collab/automations.test.mjs:17-35` (`{ key: value, … }` on one line; every `automation` file must exist and be
  named after the seat, `:59-68`; the exceptions seat must be `kiro-web`, `:70-76`).
- So four of the owner's accounts are already seats (Kiro 1 = `hotmail`, Kiro 2 = `exafy`, Kiro 3 = `exafyltd`, Kiro 12 =
  `jtadic`); Kiro 4, 5 and 6 are not. (The owner wrote "six newly identified"; the list has three new emails.)
- Each existing seat has a GitLab user `agent-kiro-<seat>` (`infra/gitlab-engineering/settings/gitlab-settings.json:36,43,50,57`);
  creating GitLab users or tokens for new seats is a credential change and is not part of this plan.
- A lane's `seat` must name a seat of `areas.yaml` (`queue.mjs:1210`), so a new account cannot be given lanes until it is a seat.

## 3. Interfaces
One lane. It edits `docs/programs/areas.yaml` only (a governance path, `queue.mjs:86-87`; not a protected gate file,
`scripts/collab/protected-gate-files.json`). No automation file, no area, no GitLab account, no token, no workflow.

## 4. Lanes
### Lane `seats` (seat `exafy`, governance path → `reviewer_seat: agent:vitana-lane-reviewer`)
- Add `kiro: <n>` (the owner's slot number) to each existing seat: `hotmail` 1, `exafy` 2, `exafyltd` 3, `jtadic` 12.
- Add three seats, no `automation`, no area: `vitanaland` (`kiro: 4`, `d.stevanovic@vitanaland.com`), `office`
  (`kiro: 5`, `office@exafy.io`), `support` (`kiro: 6`, `support@exafy.io`), each with `surface: pending` until the
  account's first session records its surface.
- Add a comment block, indented two spaces inside `seats:` (e.g. `  # Kiro 7–11: reserved …`) so `loadSeats`
  (`queue.mjs:1193`, which ends the block at any column-0 line) and `automations.test.mjs:23` (which skips comments)
  both keep reading seats added below it, listing slots 7–11 as reserved (no seat until the owner names the account), and the rule that an
  account is a login, a seat is its configured identity, a session is one execution context; two seats run by one
  operator are two accounts, not two independent agents unless their sessions are.
- `docs/validation/<VTID>/`: `acceptance.md`, `commands.log`, `scope.json`, the before/after seat table.

Paths: `docs/programs/areas.yaml`, `docs/validation/VTID-*/**`.

## 5. Parallel / hot files
Single lane. `areas.yaml` is read by every lane check; the edit adds keys and lines only (no seat renamed or removed).

## 6. Tests and commands
`node --test scripts/collab/automations.test.mjs scripts/collab/queue.test.mjs`, `node scripts/collab/queue.mjs
validate` via preflight, a check that `loadSeats` returns the seven seats.

## 7. Measurement
Seven seats, each with `kiro:` and `account:`; slots 7–11 listed as reserved; tests green.

## 8. Risks
- A seat without `automation` is never woken by a Kiro Web automation; its lanes are built only when its account runs a
  session. Intended until each account is verified.
- An email in the repository: the four existing seats already list theirs; the owner supplied the three new ones for
  this purpose.

## 9. Unchanged
Areas and their seats, `exceptions_seat`, automation files, GitLab users and tokens, repository permissions, CLAUDE.md.
<!-- plan:end -->
