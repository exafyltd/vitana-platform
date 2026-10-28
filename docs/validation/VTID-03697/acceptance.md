# VTID-03697 — Restore the production gateway deploy (26 dispatch inputs > GitHub's limit of 25)

Evidence pack. This is a regression I introduced earlier the same day and
found when the first real production publish was attempted.

**Impact while broken:** `AWS-PROD-DEPLOY-GATEWAY.yml` could not be dispatched
at all, so production gateway deploys were offline — including the Command Hub
PUBLISH button, which dispatches this same workflow. It was invisible because
the workflow is `workflow_dispatch`-only: no push exercises it, so the failure
surfaces only when someone tries to ship.

---

AC-1 — The workflow parses and is dispatchable again

GitHub refuses to parse a workflow with more than 25 `workflow_dispatch`
inputs; it is not a truncated input list, the whole workflow becomes
undispatchable. Commit `3d8cb429` added `narration_audio_cache` and
`narration_audio_bucket`, taking the file from 24 to 26.

TEST: `services/gateway/test/scripts/workflow-dispatch-input-limit.test.ts` —
"AWS-PROD-DEPLOY-GATEWAY.yml specifically stays dispatchable"
Output: `outputs/input-count.txt` (24 inputs, limit 25, narration inputs absent)

AC-2 — Removing those two inputs breaks no known caller

Verified by reading both callers rather than assuming:
- `services/gateway/src/routes/operator.ts` (Command Hub PUBLISH) dispatches
  with exactly `reason`, `deploy_mode`, `expected_commit`.
- `scripts/deploy/publish-to-prod.sh` passes only its own
  service/vtid/environment/health_path/canary/initiator set.

Neither has ever passed a narration input.

TEST: `workflow-dispatch-input-limit.test.ts` — "no workflow exceeds GitHub's
25-input maximum"

AC-3 — Nothing is lost operationally by removing them

`NARRATION_AUDIO_CACHE` resolves to `memory` in code when unset, which is the
intended production value, so the removed input has no live use. The `s3` leg
is explicitly unaccepted (CLAUDE.md §2c-cache): the bucket does not exist and
`vitana-ecs-task-role` has no s3 grant, so `narration_audio_bucket` had no
legitimate value to carry either.

TEST: `services/gateway/test/services/tts/narration-audio-cache.test.ts` —
"defaults to memory when unset"
TEST: `narration-audio-cache.test.ts` — "treats an UNRECOGNISED value as
memory, not off"

AC-4 — The limit cannot be crossed silently again

The guard walks every workflow file and fails if any `workflow_dispatch`
exceeds 25 inputs, and warns when one is within 2 of the ceiling. Asserted
across ALL workflows rather than pinning the one that broke — the next file to
approach the ceiling is the one nobody is watching.

TEST: `workflow-dispatch-input-limit.test.ts` — all 4 cases
Output: `outputs/input-limit-tests.txt` (4/4 passing; the near-ceiling warning
fires at 24, which is the signal that would have made this a decision rather
than an accident)
Note: mutation-verified — re-adding two probe inputs turns the guard red with
`AWS-PROD-DEPLOY-GATEWAY.yml: 26 inputs`, then restored to 24.

---

## Verification summary

| Check | Result |
|---|---|
| `AWS-PROD-DEPLOY-GATEWAY.yml` dispatch inputs | 24 (was 26) |
| `workflow-dispatch-input-limit.test.ts` | 4/4 passing |
| Mutation check (re-add 2 inputs → red) | confirmed, then restored |
| Callers re-read for removed inputs | `operator.ts`, `publish-to-prod.sh` — neither passes them |
| Live dispatch of the fixed workflow | **pending — this PR must merge first** |

## Known limitation carried forward

The file is at 24 of 25. A future env toggle cannot simply be appended. Either
retire an obsolete input first, or replace the one-input-per-env-var pattern
with a single JSON `env_overrides` input. Recorded in the workflow itself, at
the point where the next person would add one.
