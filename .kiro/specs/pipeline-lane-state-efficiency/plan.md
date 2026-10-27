---
change_class: standard
---
# plan(pipeline-lane-state-efficiency): one closing record may carry a chain of legal lane/plan transitions
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610271503-9458` (Kiro Web). Repo: `exafyltd/vitana-platform`
only. Premises pinned to `origin/main` `fe4495db71`. Detail per lane: `tasks.md`.
<!-- plan:begin -->
## 1. Goal
Owner, 2026-10-27 (Kiro Web): *"Create a plan named `pipeline-lane-state-efficiency` to allow valid chains of state
transitions in one closing record. Preserve validation of every transition, authorization, and the audit trail.
Include tests for valid and invalid chains. Proceed through the required protected-file review and existing
pipeline."* Measured cost today (pipeline analysis, 2026-10-27): owner-autonomy's two lanes merged their code by
12:09Z, then needed six serial bookkeeping PRs (#4397, #4399, #4400, #4401, #4402, #4403), ~3.5 min of CI each and
~25-30 min of wall time, about 45% of request → done for that small task; 35 bookkeeping PRs in two weeks.

## 2. Today (`fe4495db71`)
1. `scripts/collab/queue.mjs:38-52` `PLAN_EDGES` / `LANE_EDGES`; `:246-258` `checkTransition(kind, before, after)`
   compares only the front-matter `state` of the merge-base and the head, so `executing → verified` (two edges) is
   `illegal transition` even when both edges are legal and logged.
2. `:535-561` `validateRange` calls `checkTransition` once per touched spec file; the only multi-edge exception is the
   `ci-plan-spar` plan-file case (`:554-558`, VTID-05214).
3. `:562-604` authorization is per commit and independent of the transition check: `Collab-Session`/`Collab-Lane`
   trailers, one work lane per PR, one session per lane, `claimed_by` = the committing session, `pm-agent` overreach,
   review entries (`Collab-Review`) may only append with the front matter unchanged. This plan does not change it.
4. Log entry format (collaboration.md §2, `:71`): `### <ISO time> · <session id> · <state change>`; review entries
   (§3, `:89-108`) carry `review: accept|changes` and `head: <sha>`. The merge sha is written in two forms today:
   `merge: <sha>` in the `in-review → verified` entry (`.kiro/specs/kiro-web-steering/lanes/web-steering.md:56-57`) and
   ``Merge `<sha>` `` in the `verified → done` entry (`:59-60`).
5. `queue.mjs` is a protected gate file (`scripts/collab/protected-gate-files.json`); `queue.test.mjs` is not.
6. Other work on `queue.mjs`: no open lane PR (checked 2026-10-27T15:20Z: #4392, #4396, #4404, #4406, #4409 do not
   list it). Lane `ci-github-modernization/false-positives-collab` (VTID-05304, `ready`, executor claude) also lists
   `queue.mjs` + `queue.test.mjs`: its T2 stops counting `ci-plan-spar` as a second session on a `_plan` lane (the
   false positive that fails Collab handoff on every answered `plan(` PR, e.g. #4393, #4406). Whichever lane lands
   second merges `origin/main` first and re-runs its tests (one merge per repo); the two changes touch different
   functions (`validateRange` transition loop vs. the session-per-lane loop). `plan-pr-automerge` of plan `pipeline-agent-wake-and-review` will add one line to
   `PROTECTED_GATE_BUILTIN` later and is sequenced after this lane (hot file).

## 3. Change — one lane `chain-transitions` (vitana-platform, `executor: claude`)
1. **New exported `transitionChain(kind, beforeText, afterText)`** in `queue.mjs`. Inputs are the full file texts at
   the merge-base and at the head. It returns `{ ok: true }` or `{ ok: false, errors: [...] }`:
   - **Append-only log.** The log section (`## Log` to end of file) at the merge-base must be a prefix of the log at
     the head; otherwise `log rewritten: entries before the head may only be appended to`.
   - **Edges from the new entries.** The new entries (head log minus base log) are parsed for headers whose state
     change has the form `<a> → <b>` (both known states). Review entries (`· review` / `· review: …`) and
     `update`/free-text headers carry no edge.
   - **Endpoints.** The first edge starts at the base `state`, every next edge starts where the previous one ended,
     and the last one ends at the head `state`. Otherwise `chain does not connect <base> → <head>: <list>`.
   - **Every edge is legal.** Each edge is checked with the existing single-edge rule (`checkTransition` on
     `{state:a}`/`{state:b}`), so `done` stays terminal, `parked` returns only to `parked_from`, and a new file still
     starts at `drafted`/`ready`. `parked_from` is tracked through the chain (R1-F1): it starts as the base front
     matter's `parked_from`; an edge `X → parked` sets it to `X`; a following `parked → Y` edge is checked with
     `{state:'parked', parked_from}`. If the head state is `parked`, the head `parked_from` must equal the tracked
     value.
   - **Order.** Entry times are non-decreasing; at most 6 edges per PR.
   - **Evidence per edge (lanes).** `executing → in-review`: the entry body names the lane PR (a GitHub PR URL).
     `in-review → verified`: an entry `review: accept` with a 40-hex `head:` exists after the last `→ in-review` edge
     and before this edge, in the base log or the new entries; `in-review → executing` needs a `review: changes` entry
     in the same window. `verified → done`: a merge sha (7-40 hex) in the form `merge: <sha>` or ``Merge `<sha>` `` (case-insensitive)
     appears in this entry or in the `in-review → verified` entry of the same window (R1-F2, both conventions of
     §2.4). Missing evidence →
     `<a> → <b> has no <evidence> in its log window`.
   - **Evidence per edge (plans).** Every edge has its own entry; `→ done` for a plan additionally needs every lane
     file at the head in `done` (checked by the caller, which has the tree).
2. **`validateRange` uses it.** When `checkTransition` rejects a touched lane/plan file and the change is more than
   one edge, `validateRange` calls `transitionChain`; the file passes only when the chain is `ok`. A single legal edge
   behaves exactly as today (no evidence demanded beyond today's), and the `ci-plan-spar` exception is unchanged.
3. **A new review entry inside the range must be backed by its commit.** For a chain whose `in-review → verified`
   evidence is a review entry first added in this range, the range must contain the commit that added it with
   `Collab-Review: <slug>/<lane>`, `Collab-Verdict: accept` and `Collab-Reviewed-Head` equal to the entry's `head:`;
   otherwise `review entry without its Collab-Review commit`. This keeps the reviewer's authorization (`:597`) as the
   only way to write an accept.
4. **Authorization unchanged.** All per-commit checks of §2.3 run as before on every commit of the range; a chain
   only lets one PR carry several of today's single-edge commits.
5. Tests (in `scripts/collab/queue.test.mjs`, written first and red on `origin/main`):
   - Valid: lane `executing → in-review → verified → done` in one PR with PR URL, accept review (with its
     `Collab-Review` commit) and a merge sha (both conventions); lane `in-review → executing → in-review` with a
     `review: changes` entry; lane `executing → parked → executing → in-review` (R1-F3); plan `executing → in-review → verified` with one entry per edge; a single edge still passes with no new
     evidence (regression).
   - Invalid (one error each): `executing → parked → in-review` (parked returns to the wrong state, R1-F3); a head
     `parked` whose `parked_from` differs from the tracked value; a skipped state (`executing → verified` with only one entry); entries out of order;
     an entry `ready → done`; a chain leaving `done`; `parked → executing` when `parked_from: in-review`; `in-review
     → verified` without an accept entry; an accept entry added without its `Collab-Review` commit; an accept whose
     `head` differs from `Collab-Reviewed-Head`; `verified → done` without a merge sha in either entry; a base log entry edited or
     removed; 7 edges; the chain's last edge not matching the head `state`; a commit from a second session (still
     `one session per lane`).
   - `node --test scripts/collab/*.test.mjs` green; preflight green.

## 4. Unchanged
The state machine (edges), `collaboration.md` text, every commit-trailer, session, claim, `pm-agent` and Lane-scope
rule, the PM's own writes, the `ci-plan-spar` exception, and every merge rule (§7b). A closing record that uses one
edge per PR still passes. Nothing deploys.

## 5. Merge routing and measurement
- `queue.mjs` is protected: after the reviewer agent's accept and green checks the lane waits for a legacy Claude
  review on the current head or an owner instruction naming `pipeline-lane-state-efficiency`; until then it stays
  `verified`, `next_actor: owner` (stop 3 of `vitana-owner-autonomy.md`).
- Measurement in `docs/validation/<VTID>/timings.json`: closing-record PRs per lane and minutes from code merge to lane
  `done`, before (owner-autonomy: 3 PRs/lane, ~25 min) and for the first plan closed after merge.

## 6. Risks
- A forged chain: every edge still needs its own logged entry from a session that passes the existing trailer and
  claim checks, and an accept needs its `Collab-Review` commit; the log is append-only.
- A parser mismatch with hand-written headers: unknown headers carry no edge, so the chain fails closed and the
  author falls back to one edge per PR (today's behaviour).
<!-- plan:end -->
