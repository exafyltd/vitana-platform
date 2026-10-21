# Responses to sparring session 2, round 2

Session `c48d3889-2318-40ca-bc26-b143274fd7b5`.

Both round-2 findings are **accepted** and both were under-specification defects I left in the lane
text — each is now resolved by committing the plan to exactly one concrete mechanism, verified against
`origin/main`.

- **R2-F1 (major, accepted).** The partner is right that R1-F4 was accepted in words but the lane text
  still offered "(a) … or (b) … the lane must commit to one of these", leaving the architectural choice
  to the implementer. The partner's own analysis also eliminates the two options I had floated: re-run
  (`.../runs/{id}/rerun`) re-runs the *old* run against the *old* SHA, not the new bot head, so it does
  not start checks on the pushed commit; and the Checks API needs an installation token with
  `checks:write`, which the `pull_request_target` `GITHUB_TOKEN` does not carry. Lane 5 now commits to
  **one mechanism that is within the token's capability and needs no owner config: a commit status** (not
  a check run) on the new bot head. After the round-commit push (`PLAN-SPAR.yml:116`), one step guarded by
  `if: steps.guard.outputs.skip != 'true' && secrets.PLAN_SPAR_PUSH_TOKEN == ''` reads the pushed head SHA
  (`git -C head rev-parse HEAD`) and posts `POST /repos/{owner}/{repo}/statuses/{sha}` via `gh api` with a
  fixed `context=plan-spar/needs-rebase`, `state=pending`, `target_url` → the run. `GITHUB_TOKEN` carries
  `statuses: write` by default (statuses are not checks), so no PAT is required for the signal. The PM /
  land step reads that status on the PR head and, when present and `pending`, runs `gh pr update-branch`
  (a re-push under a trigger that *does* start `pull_request` checks) before evaluating merge readiness —
  the status is an observable signal, not a blocking required check, and the land-step read is a non-gate
  `scripts/ci/**` concern that does not touch the `queue.mjs` subcommand contract. Detection logic is
  explicit (empty `PLAN_SPAR_PUSH_TOKEN` = the `GITHUB_TOKEN` push; with the PAT present the step is
  skipped and checks start normally). The PAT secret stays owner config → Gate 2. Plan lane 5, `tasks.md`
  T1–T3 (+ acceptance) and the lane file now pin this single mechanism and name the status context the
  test asserts.

- **R2-F2 (major, accepted).** The partner is right that the `services` job shares one `steps:` block
  across all three matrix entries (`TEST-SUITE.yml:103`, confirmed on `origin/main`: two run-steps,
  `Install` → `${{ matrix.install }}`, `Run tests` → `${{ matrix.test }}`, under
  `defaults.run.working-directory: services/${{ matrix.service }}`), so adding a `typecheck`/`guardrails`
  matrix key alone creates a variable, not a step, and a shared step using an absent key would emit an
  empty `run:` for `oasis-projector`/`openclaw-bridge`. Lane 6 now commits to **option (A)**: add
  `typecheck: npm run typecheck` and `guardrails: npm run test:guardrails`
  (`services/vcaop/package.json`: `typecheck` = `tsc --noEmit`, `test:guardrails` =
  `jest --runInBand test/guardrails`) **only** to the `vcaop` matrix entry, and after `Run tests` add two
  steps to the shared body — `- name: Typecheck` with `if: matrix.typecheck != ''` /
  `run: ${{ matrix.typecheck }}`, and `- name: Guardrails` with `if: matrix.guardrails != ''` /
  `run: ${{ matrix.guardrails }}`. An absent matrix key renders as `''`, so the `if:` is false for the
  other two entries and no empty `run:` is ever emitted for them; only vcaop runs the two steps, and
  `--runInBand` is preserved inside the `test:guardrails` script. The lane-6 proof test is made observable
  and provable: it **parses `TEST-SUITE.yml`** and asserts (a) the `vcaop` entry carries `typecheck` and
  `guardrails` keys, (b) the shared body has the two `if:`-guarded steps, and (c) the other two entries
  carry neither key — red on base (today vcaop runs only `npm test` and the guarded steps do not exist),
  green on head. Plan lane 6, `tasks.md` T5 (+ acceptance) and the lane file now pin option (A) and this
  test.

No finding was rejected or deferred.

```json
[
  {"finding_id": "R2-F1", "disposition": "accepted", "rationale": "Lane 5 committed to one mechanism: on the empty-PLAN_SPAR_PUSH_TOKEN (GITHUB_TOKEN) push, post a plan-spar/needs-rebase commit status on the new bot head via POST /repos/{owner}/{repo}/statuses/{sha} (GITHUB_TOKEN has statuses:write by default; no PAT needed for the signal). PM/land step reads the status and runs gh pr update-branch so checks start under a re-push. Rejected the re-run option (re-runs the old SHA, not the new head) and the Checks API option (needs checks:write the pull_request_target GITHUB_TOKEN lacks). Detection = empty secret; with the PAT present the step is skipped. Plan lane 5 + tasks T1-T3 + lane file pin it; the test asserts the status is posted on the bot head. PAT secret stays Gate 2."},
  {"finding_id": "R2-F2", "disposition": "accepted", "rationale": "Verified on origin/main: the services job shares one steps block across all three matrix entries (TEST-SUITE.yml:103), so a new matrix key alone creates no step. Lane 6 committed to option A: add typecheck=npm run typecheck and guardrails=npm run test:guardrails to the vcaop matrix entry only, and after Run tests add two shared-body steps guarded by if: matrix.typecheck != '' and if: matrix.guardrails != '' running ${{ matrix.typecheck }} / ${{ matrix.guardrails }}. Absent keys render as '' so the guards are false for oasis-projector/openclaw-bridge and no empty run: is emitted; --runInBand stays in the script. The proof test parses TEST-SUITE.yml and asserts the vcaop keys, the two guarded steps, and the absence of the keys on the other two entries - red on base, green on head. Plan lane 6 + tasks T5 + lane file pin it."}
]
```
