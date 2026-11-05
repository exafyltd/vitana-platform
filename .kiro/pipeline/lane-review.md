# Lane review: the reviewer agent `vitana-lane-reviewer` (model fallback chain)

Binding: `common-rules.md`. The review step runs the workspace agent `.kiro/agents/vitana-lane-reviewer.md`. The
agent is read-only: it returns two text blocks and writes nothing. A store watch copies them to `RUN/reviews/`; the
**land step** (a writing agent) stores them and commits the review entry. Approvals come only from this agent, never from another Kiro seat or session, and never
from the lane's own session.

## Model chain (never wait on an unavailable model)
`claude-sonnet-5.5` → `claude-opus-5.5` → `claude-sonnet-4.5`, in that order (`REVIEWER_AGENT_MODELS` in
`services/gateway/src/services/project-manager/governance.ts`; mirrored in `scripts/ci/kiro-steering/guard.cjs`).
A Kiro workflow step takes exactly one `modelId`, and a step whose pinned model cannot be served **fails** at its
first model call (in a sequence that failure would end the slot). So
every lane slot runs its three review steps as the branches of **one `parallel` with `joinPolicy: "any"`**
(`reviews-N`), one branch per chain model: `review-N` (`claude-sonnet-5.5`), `review-N-b` (`claude-opus-5.5`),
`review-N-c` (`claude-sonnet-4.5`). The engine's `any` join completes on the first branch that completes and aborts
the others; a failed branch is ignored; the parallel fails only when all three fail. The pin, not the agent's
self-report, guarantees the model. Every review step's prompt starts with exactly
`Reviewer chain model for this step: <modelId>. ` (its own `modelId`, once per prompt; the steering guard enforces
it), and the agent keys on that line and reports exactly that id.
Each branch is `[review step, store watch]`: the command watch `node scripts/collab/store-review.cjs` copies that
step's output to `RUN/reviews/<LANE>-<head7>.out-<model>.md` (the reviewer stays read-only). The land step reads
those files, never `{{review-…output}}` directly, because a failed or aborted branch has no captured output and a
template naming it fails the step (the steering guard rejects such a template).
**Trade-off (owner 2026-10-21, "don't let us wait for a model that is unavailable"):** the models race instead of
being tried one after another. No slot ever waits on an unavailable model, but when all three are up, all three
start a review and the fastest wins, so the reviewing model is not always `claude-sonnet-5.5`. Every chain model is
an accepted reviewer (`REVIEWER_AGENT_MODELS`), so the gate is the same whichever wins.
**All three fail:** `reviews-N` fails at once (no wait), which fails that slot's repeat with the engine's failure
record naming each branch. The slot's gate race (`slot-N`, `joinPolicy: "any"` of `slot-N-skip` and the repeat)
would then wait on the idle skip watch, so `slot-N-skip` reads the run's engine state, appends one line to
`RUN/blockers.md` and ends the race; the other slots run on, and the lane's state keeps `done: false` for the later
steps to report. Each model has then been tried exactly once on that head. A relaunch of the recipe resumes from the
state files and races the three models once more.
**Only review steps pin a model.** Every other step (setup, planning, sparring, code, land, staging, Gate 2) carries
no `modelId`: it inherits the launching session's model, and on a transient model error (5xx, throttling) the engine
pauses it and resumes it, so it does not fail on an unavailable model. Racing those steps across models like the
reviews would run their side effects (commits, pushes, PRs, merges) more than once, so they are not raced. The
steering guard fails a `modelId` on any step outside a reviewer race and any pin outside this chain. The plan
sparring partner has its own chain on `main` (CLAUDE.md rule 53: Opus 4.6 → Sonnet 4.6 → DeepSeek; plan
`sparring-model-fallback`).

## When the agent reviews
Only if `RUN/lanes/<LANE>/state.json` has `done: false`, `status: in_review`, and
`RUN/reviews/<LANE>-<head7>.json` (head7 = first 7 hex of `head_sha`) does not exist yet. Otherwise its final
message is exactly `no review needed (<status>)` (the store watch then writes nothing).

## What the review step's prompt gives the agent
Lane key `<slug>/<LANE>`, PR URL(s) and number(s), the head SHA per repo, the repo checkout paths, the spec paths on
`origin/main`, `RUN/lanes/<LANE>/impl-notes.md`, and any lane-specific check. Checklist item 10 always includes, read from the
`Change types:` bullet of the lane's Acceptance group in `tasks.md`, the "Reviewer" lines of those sections of
`quality-checks.md` and its Acceptance template fields; a missing `Change types:` bullet, a field left empty, or an
outcome only unit-tested but reported as verified is a finding. If the plan carries an owner instruction
covering its protected gate files, the prompt names it (checklist item 9).

## What the agent checks (its checklist, in its definition)
Acceptance criteria of the lane in `tasks.md` + lane file; files within `paths`; CI on the current head (failed
required check = blocking, running = non-blocking note); every new behaviour has a test red on base; no test
weakening; no production or live writes, no hand VTID, no PUBLISH / `publish-to-prod.sh` / `AWS-PROD-*`; no
hardcoded spoken strings; i18n / design / RTL if UI is touched; protected gate files
(`scripts/collab/protected-gate-files.json`) are blocking for agent-only acceptance. It does not re-run suites.

## What it returns
1. The verdict JSON (plan interface §4.2):
   `{"verdict":"accept"|"changes","head_sha":"<40-hex>","findings":[{"severity":"blocking"|"non-blocking","file":"<path>","line":<n>|null,"issue":"<text>"}],"model":"<chain model it ran on>","agent":"vitana-lane-reviewer"}`;
   `accept` only with zero blocking findings.
2. The lane-log review entry (§4.1) with the trailers
   `Collab-Session: <reviewer session>`, `Collab-Review: <slug>/<LANE>`, `Collab-Verdict: accept|changes`,
   `Collab-Reviewer: agent:vitana-lane-reviewer (<model>)` (the same chain model as the JSON),
   `Collab-Reviewed-Head: <40-hex>`. `Collab-Review` keeps the lane key; the verdict is only in `Collab-Verdict`.
3. The prompt's line `Reviewer chain model for this step: <id>` is the authoritative pin: a chain-model `<id>` is the
   agent's model (no introspection; other chain-model names elsewhere in the prompt are not a conflict). Only when
   that line is missing, or names a model outside the chain → only
   `{"error":"model_unavailable","required":["claude-sonnet-5.5","claude-opus-5.5","claude-sonnet-4.5"],"agent":"vitana-lane-reviewer"}`.
   That is "no review on this model" (the store watch writes nothing for it).
   A verdict whose `model` is not the model in its `.out-<model>.md` file name (the pin of the step that produced
   it), whose `model` differs from its `Collab-Reviewer` model, or whose `agent` differs is ignored and logged. A new
   entry never uses the bare identity.

## How the land step stores it
From the first `RUN/reviews/<LANE>-<head7>.out-<model>.md` that holds a valid verdict for `head_sha`, taking the
files in chain order: `RUN/reviews/<LANE>-<head7>.md` (the whole output), `<LANE>-<head7>.json` (block 1
exactly), `<LANE>-<head7>-entry.md` (block 2 with `<reviewer session>` replaced by a reviewer session id: `queue.mjs
session-id --agent agent:vitana-lane-reviewer` once that form exists on `main`, else `--agent kiro --seat
<reviewer_seat>`; never a session in the lane's executing log). Then `lane-land.md` step 2.
