# Tasks — reviewer-agent-reliability
Authoritative plan: `plan.md` (between the plan markers). Lane file: `lanes/reviewer-fix.md`. VTID: allocated by CI
PLAN-SPAR after policy approval; never by hand. Branch `kiro/reviewer-agent-reliability/reviewer-fix`, PR title
`VTID-xxxxx (reviewer-agent-reliability/reviewer-fix): …`, trailers `Collab-Session` +
`Collab-Lane: reviewer-agent-reliability/reviewer-fix` on every commit, identity `kiro-agent[bot]`, no
`Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/` (`commands.log` with every command and pass/fail
counts, `outputs/red-on-base.txt` + `outputs/green-head.txt`, `acceptance.md` with `TEST:` lines, `timings.json`).
Acceptance below is what the reviewer (`wf-code-reviewer` on claude-sonnet-5.5 with the `vitana-lane-reviewer`
checklist) checks the PR diff against.

<!-- lane: reviewer-fix -->
## Lane `reviewer-fix` — reviewer runs reliably; finished slots stop
- [ ] R1 `.kiro/agents/vitana-lane-reviewer.md`: section `## Model self-check (fail loudly)` (`:59-64`) replaced by
      `## Model (pinned by the caller)` with the sentence "the caller pins the model; never refuse because you cannot
      introspect your model id" (plan §4.1). Front matter `model:`, `tools`, `excludedTools` unchanged.
- [ ] R2 Same file, `permissions.rules` (`:25-33`): allow and deny lists = `gh pr view*`, `gh pr diff*`,
      `gh pr checks*`, `gh run view*`, and `git <cmd>*` + `git -C * <cmd>*` for `diff`, `log`, `show`, `fetch`,
      `rev-parse`, `remote get-url`, `merge-base`; chaining exclude list unchanged; body text `:49` matches.
- [ ] R3 `.kiro/workflows/vitana-pipeline.workflow.json`: `review-1`..`review-6` → `agent: wf-code-reviewer`,
      `modelId: claude-sonnet-5.5`, prompt loads `.kiro/agents/vitana-lane-reviewer.md` from `origin/main` as the
      checklist, read-only, returns the two output blocks, signals `send_message` success; no "model_unavailable line".
- [ ] R4 Same file: done-first sentence in every `code-N`, `review-N`, `land-N` prompt (slot null or lane done with
      empty queue → no work; `land-N` then ends with `VITANA_SLOT_DONE`); `spar` prompt: `spar-state.json` done → end
      with `VITANA_SPAR_DONE` at once. `stopWhen` values unchanged. `description` updated.
- [ ] R5 `scripts/ci/kiro-steering/guard.cjs`: review-step check, parallel-cap detection, `REQUIRED_BODY`, allowlist
      check and done-first/stopWhen check as plan §4.3.
- [ ] R6 `scripts/ci/kiro-steering/guard.test.cjs`: tests of plan §4.4; each new or changed assertion red on base.
- [ ] R7 `.kiro/pipeline/lane-review.md:3` and `:34` describe the new dispatch (plan §4.5).
- [ ] R8 Evidence in `docs/validation/<VTID>/` (no `staging-tests.json`: nothing deploys).
**Acceptance:**
- The diff touches only the five files of plan §4 and `docs/validation/<VTID>/**` (+ this spec's lane log).
- No text in the agent file still makes "cannot tell my model" a reason to refuse; the verdict and entry formats,
  checklist items 1-10, `name`, `model`, `tools`, `excludedTools` are byte-identical to base apart from R1/R2.
- The allow list permits exactly the read-only commands of R2 (with and without `-C`); no write command (`git push`,
  `git commit`, `gh pr merge|review|comment|edit`, `gh run rerun`, `gh workflow run`) is allowed; the chaining exclude
  list is unchanged.
- All six review steps are `wf-code-reviewer` + `claude-sonnet-5.5` + the checklist path; at most 6 lane branches.
- Every slot's `stopWhen` is `{{land-N.output}} contains VITANA_SLOT_DONE` for its own N; every slot prompt has the
  done-first sentence; the recipe passes `validateWorkflow`.
- `node --test scripts/ci/kiro-steering/guard.test.cjs` and `node scripts/ci/kiro-steering/guard.cjs .` green on head;
  the new/changed assertions fail on `origin/main` (`outputs/red-on-base.txt`); no test deleted, skipped or loosened
  beyond replacing the two assertions that pinned the old behaviour (`guard.test.cjs:103-105`, `:136-137`).
- Protected gate file `.kiro/agents/vitana-lane-reviewer.md` is reported as checklist item 9, non-blocking, citing the
  owner instruction of plan §6.
