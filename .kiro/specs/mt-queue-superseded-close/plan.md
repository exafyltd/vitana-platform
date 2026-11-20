---
change_class: standard
---
# Plan — mt-queue-superseded-close
Let a plan reach `done` when each of its parked lanes was replaced by a lane that is done, without weakening any other
rule of the plan-close gate.
<!-- plan:begin -->
## Goal (owner instruction)
Owner directive `docs/multitenancy/KIRO-HOTMAIL-DIRECTIVE-M0.md` on branch `claude/youthful-cannon-vzsnio`
(`exafyltd/vitana-platform`), decision 3: *"Superseded-lane rule (approved). Kiro changes `scripts/collab/queue.mjs`
(around line 390) so a plan may reach done when each parked lane records `superseded by` a lane that is done. This is a
protected gate file. This directive is the owner instruction naming the plan `mt-queue-superseded-close` for that
change. The change still needs a reviewer-agent accept on the current head before it merges. Affected plans:
mt-track-s-r2, mt-guardrails-r2, mt-track-s-authz."*

## Today (`origin/main` @ `6dc6e1ba0c`)
- `transitionChain` (`scripts/collab/queue.mjs:328`) ends with the plan-close rule at `:390`:
  `kind === 'plan' && after.state === 'done' && laneStates && laneStates.some((s) => s !== 'done')` →
  `a plan chain may end "done" only when every lane is done`. A parked lane is never `done`, so a plan with a parked lane
  can never close, even when another lane replaced it.
- The only caller builds `laneStates` as the list of lane front-matter states of the plan at the head (`:820-823`,
  `validateRange`) and passes it at `:824`.
- Parked lanes record "superseded" **only as log text**, not in front matter: `mt-track-s-r2/s-j-retire-allowlist`
  (parked by #4880, VTID-05441, "superseded by s-j-retire-allowlist-v2"), `mt-guardrails-r2/local-test-stack` (#4881,
  VTID-05447) and `mt-guardrails-r2/local-test-stack-v2` (#4882, VTID-05469), both "superseded by
  local-test-stack-pglite (VTID-05520)". There is no front-matter field, so a check cannot read it reliably.
- `validateLane` (`:195-257`) checks `parked_from` for a parked lane (`:252`) and ignores unknown front-matter keys.
  `scopeCheck` pins only `executor`, `seat`, `reviewer_seat`, `paths`, `lane_admin` to the trusted revision
  (`:1000-1004`); `superseded_by` is not a permission field.
- Affected plans on `main` (lane states read from the trees): `mt-track-s-r2` (`s-j-retire-allowlist` parked, replaced
  by `s-j-retire-allowlist-v2`, done), `mt-guardrails-r2` (`local-test-stack`, `local-test-stack-v2` parked, replaced by
  `local-test-stack-pglite`, done; other lanes of that plan are outside this plan), `mt-track-s-authz`
  (`approvals-auth`, `work-surface-permission` are `ready`, replaced in practice by the `-v2` lanes, which are done; they
  are not parked today, so they are outside this plan).

## Changes
### Lane `superseded-close` — `scripts/collab/queue.mjs` (+ `queue.test.mjs`)
1. **Machine-readable field.** A lane records the replacement in front matter: `superseded_by: <lane-id>`. The log text
   stays as the human record. `validateLane` accepts the key and checks it: only on a lane with `state: parked`; the
   value matches the lane-id pattern (`SLUG_RE`), is not the lane's own id, and (when `laneIds` is given) is a lane of the
   same spec. A lane without the key validates exactly as today (no existing lane file changes meaning).
2. **Close rule.** `transitionChain` takes an optional `lanes` list of `{id, state, superseded_by}` next to the existing
   `laneStates`. When `lanes` is given, a plan chain may end `done` only when every lane satisfies one of:
   - `state === 'done'`; or
   - `state === 'parked'` and `superseded_by` names a **different lane of the same plan whose `state` is `done`**.
   Anything else keeps the existing error and names the lane(s) that block, e.g. `a plan chain may end "done" only when
   every lane is done, or parked with superseded_by naming a done lane of the plan (blocking: <lane> (<state>) …)`.
   The text keeps the substring `every lane` for existing callers. When only `laneStates` is passed (old callers, old
   tests) the behaviour is the old one: all `done`. `validateRange` (`:820-823`) builds `lanes` in **one** pass over the
   plan's lane files (one `showFile` + `parseFrontMatter` per file, mapped to `{id, state, superseded_by}`) and derives
   `laneStates` from that same array, so it adds no second read of any lane file (round 1, R1-F1).
3. **What does not change.** A bare parked lane (no `superseded_by`) still blocks. `superseded_by` naming a lane that is
   not `done` (`ready`, `executing`, `in-review`, `verified`, `parked`), a lane outside the plan, or the lane itself still
   blocks. A chain of supersessions does not close either: A superseded_by B where B is parked does not pass; only a
   `done` lane counts. Every other check of `transitionChain` (edge legality, evidence, review entries) and every other
   rule of `validateLane` / `scopeCheck` / `validateRange` is untouched. No lane or plan state of any affected plan is
   changed by this plan.
4. **Backfill (outside this plan).** After the rule is on `main`, the closing record of each affected plan adds one
   front-matter line `superseded_by: <lane-id>` to its parked lanes (`s-j-retire-allowlist` → `s-j-retire-allowlist-v2`;
   `local-test-stack`, `local-test-stack-v2` → `local-test-stack-pglite`). That is the plan owners' normal closing
   record; this plan does not edit their files.

## Shared files, dependencies, order
- One lane, two code files (`scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`) plus `docs/validation/<VTID>/`.
  No other lane or agent edits them in this plan. `depends_on: []`.
- `docs/programs/standalone/program.md` gains one line from this plan PR (spec listed in the programme registry).
- `scripts/collab/queue.mjs` is a **protected gate file** (`scripts/collab/protected-gate-files.json`, collaboration.md
  §3a). The test file is a governance path (`scripts/collab/**`) but not protected. The merge needs the owner's
  instruction naming this plan (the directive quoted above) **and** a reviewer-agent accept on the current head (§7b).
  `queue.test.mjs` is not in `protected-gate-files.json`; nothing else in that file is touched.

## Tests (red on base, green on head)
`node --test scripts/collab/*.test.mjs` (PR-GATE "Collab tests"). New tests in `queue.test.mjs`, written first and
recorded red on `origin/main`:
- close allowed: `chain('plan', …, { lanes: [done, parked+superseded_by→done lane] })` → `[]`; the three real shapes
  (mt-track-s-r2, mt-guardrails-r2) with `superseded_by` added in memory → `[]`.
- no loosening: a parked lane without `superseded_by` → error; `superseded_by` naming a lane in each of the states
  `ready`/`executing`/`in-review`/`verified`/`parked` → error; naming itself, a missing lane, or a lane of another plan →
  error; a supersession chain through a parked lane → error; `superseded_by` on a non-parked lane never helps (a `done`
  or `ready` lane with the key behaves as its state).
- compatibility: `chain('plan', …, { laneStates: ['done','done'] })` and the existing `['done','verified']` error still
  behave as today.
- `validateLane`: `superseded_by` accepted on a parked lane naming a sibling; refused on a non-parked lane, on itself,
  on a non-lane; a lane without the key unchanged.
- `validateRange` end to end on a temporary git repo: a plan-close chain with one parked+superseded lane passes, with a
  bare parked lane fails.
- Evidence in `docs/validation/<VTID>/commands.log`: the red-on-base run, the green run, `queue.mjs validate` on both
  checkouts, and a dry run over the real `mt-guardrails-r2` and `mt-track-s-r2` lane files (with the field added in a
  temporary copy; no file of those plans is edited) showing the close allowed, plus a plan with a bare parked lane still
  refused. No staging deploy: these files deploy nothing; the lane is done when merged with green checks.

## Lanes
- `superseded-close`: executor **claude** (protected gate file; today's validator and Lane scope refuse `executor: kiro`
  for `scripts/collab/queue.mjs`, `queue.mjs:240`, `:1034`), built by the Kiro seat `hotmail` under the same bootstrap
  the `collab-handoff-check-fix/validator-fix` lane used (Claude Code is retired; reviewer is the agent
  `vitana-lane-reviewer (claude-sonnet-5.5)`). Paths: `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`,
  `docs/validation/VTID-*/**`.

## Risks
- A too-loose rule would let a plan close with unfinished work: the tests above pin every unsatisfied shape; the named
  lane must be `done` in the same plan, read at the head.
- `superseded_by` is writable by a lane PR on its own parked lane. It cannot close a plan alone: the replacement must be
  `done`, which needs its own accepted and merged lane, and the plan chain still needs its evidence and review entries.
<!-- plan:end -->
