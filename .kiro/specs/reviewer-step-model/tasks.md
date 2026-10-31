# Tasks — reviewer-step-model
Authoritative plan: `plan.md` (between the plan markers). Lane file: `lanes/step-model-line.md`. VTID: allocated by CI
PLAN-SPAR after policy approval; never by hand. Branch `kiro/reviewer-step-model/step-model-line`, PR title
`VTID-xxxxx (reviewer-step-model/step-model-line): review prompts open with their chain model`, trailers
`Collab-Session` + `Collab-Lane: reviewer-step-model/step-model-line` on every commit, identity `kiro-agent[bot]`, no
`Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/` (`commands.log` with every command and
pass/fail counts, `red-on-base.txt`). Acceptance below is what the reviewer agent `vitana-lane-reviewer` checks the PR
diff against. Nothing outside the lane's `paths`; no change to `services/gateway/**`, `CLAUDE.md`, `.claude/**` or
`.kiro/steering/**`; no machine paths (`<drive>:\Users\…`) or owner-question phrases in `.kiro/pipeline/*.md`;
deploys nothing.

<!-- lane: step-model-line -->
## Lane `step-model-line` — every pinned review step opens with its own chain model
- [ ] L1 Workflow (plan D1, D6): prepend `Reviewer chain model for this step: <modelId>. ` to the prompt of each of the
      18 steps with `agent: "vitana-lane-reviewer"` in `.kiro/workflows/vitana-pipeline.workflow.json`, using the
      step's own `modelId`, via a one-off Node script (logged in `commands.log`, not committed). Rest of each prompt
      byte-identical; formatting (2-space JSON, trailing newline) unchanged.
- [ ] L2 Agent (plan D2): in `.kiro/agents/vitana-lane-reviewer.md` § "Model self-check", key the self-check on the
      line `Reviewer chain model for this step: <id>`: a chain-model `<id>` there is the authoritative pin — review on
      it and report exactly it; never try to verify your own model by introspection; other chain-model names elsewhere
      in the prompt are not a conflict; `model_unavailable` only when the line is missing or names a model outside the
      chain. Keep every `REQUIRED_BODY` string (`guard.cjs:115-122`) and the exact `Model chain:` line.
- [ ] L3 Runbooks (plan D2, D4): `.kiro/pipeline/lane-review.md` — the "Model chain" paragraph (`:10-17`) states the
      D1 line as the way the step prompt names its pin and drops the claim that a pinned step never returns
      `model_unavailable`; rule 3 (`:65-67`) keys on the line like L2. `.kiro/pipeline/driver.md` step 4 (`:55-62`):
      each review session's prompt starts with the D1 line for the model that session runs on.
- [ ] L4 Guard (plan D3): `scripts/ci/kiro-steering/guard.cjs` — export `REVIEW_MODEL_LABEL`; in the review-step
      loop (`:185-189`) require `prompt.startsWith(REVIEW_MODEL_LABEL + s.modelId + '. ')` and exactly one label
      occurrence per reviewer prompt, error `review step <id> prompt must start with "Reviewer chain model for this
      step: <modelId>. "`; add the label to `REQUIRED_BODY`; require the label in `lane-review.md` and `driver.md`
      with the existing runbook-check pattern. No new model literal; `REVIEWER_MODELS` unchanged.
- [ ] L5 Tests (plan §5): `scripts/ci/kiro-steering/guard.test.cjs` — T-A … T-F with the `pipelineRepo()` / `errs()`
      fixture. Red-on-base run per plan §5 into `docs/validation/<VTID>/red-on-base.txt`.
- [ ] L6 Evidence: `docs/validation/<VTID>/commands.log`, `red-on-base.txt`, `outputs/guard-test-green.txt`,
      `outputs/guard-run-green.txt`, `plan-sparring.md` (copy of the sparring record with the approval line),
      `timings.json` (plan §6). Preflight passes on the lane head.

**Acceptance**
- Every one of the 18 reviewer steps' prompts starts with `Reviewer chain model for this step: <its modelId>. `, the
  label occurs once per prompt, and the rest of each prompt is unchanged from `origin/main` (diff shows prefix-only
  changes on 18 `prompt` lines, nothing else in the workflow JSON).
- The agent's self-check and `lane-review.md` rule 3 key on that exact line, trust a chain-model id in it, and return
  `model_unavailable` only when the line is missing or names a non-chain model; every `REQUIRED_BODY` string is still
  present; `driver.md` step 4 tells Kiro Web review sessions to open with the line.
- `guard.cjs` fails the build when a reviewer prompt lacks the line, names a different model than its `modelId`, or
  carries the label twice, and when the agent, `lane-review.md` or `driver.md` drops the label; the new check uses
  `s.modelId` / `REVIEWER_MODELS`, no new model literal.
- `node --test scripts/ci/kiro-steering/guard.test.cjs` green on head with T-A … T-F; `red-on-base.txt` shows the new
  tests failing on `origin/main`; `node scripts/ci/kiro-steering/guard.cjs .` prints `kiro-steering: OK`;
  `node --test scripts/collab/store-review.test.cjs` 7/7; the chain mirror test (`guard.test.cjs:92-99`) unchanged
  and green.
- `services/gateway/**` (incl. `governance.ts`), `store-review.cjs`, `lane-land.md` untouched; no file outside the
  lane `paths`.
- Protected gate file `.kiro/agents/vitana-lane-reviewer.md`: merge only under the owner instruction recorded in
  `RUN/decisions.md` (plan §8).
