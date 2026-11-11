# Sparring round 1 — in_progress

Session: `90113972-d727-470c-b3c4-677c7e2478d9` · plan hash `5aa7dc009d081b57f0c1215d78141203a365193c3604c5b7d000412caf85a1aa`

## Summary

Verified 10+ premises against pinned code. Most hold. One concrete gap found in the status inference logic for the new step names, and one gap in the dispatcher lane's file scope relative to the PM act module. The plan is generally well-structured with correct dependency ordering and accurate premises about the existing codebase.

## Findings

### R1-F1 [major]

The v5 step names use `.passed` (e.g. `delivery.checks.passed`, `delivery.staging.verify.passed`) but the existing status inference at events.ts:511-518 only matches `.success`, `.failed`, `.blocked`, and `.warning`. Events with a `.passed` suffix would be recorded with status `info` instead of `success`. The plan mentions the traceability lane modifies events.ts and adds an allowlist, but does not mention updating the status inference to handle `.passed`. If the inference is not updated, passed-step events will have the wrong status, breaking dashboards and any logic downstream that queries by status.

- `exafyltd/vitana-platform:services/gateway/src/routes/events.ts:510` — let eventStatus: string = "info";
      if (body.type.includes(".success")) {
        eventStatus = "success";
      } else if (body.type.includes(".failed") || body.type.includes(".blocked")) {
        eventStatus = "error";
      } else if (body.type.includes(".warning")) {
        eventStatus = "warning";
      }

Suggestion: State explicitly that the traceability lane updates the status inference to also map `.passed` to `success` (alongside `.success`), and include a test case that a `delivery.checks.passed` event gets status `success`. Alternatively, since the traceability lane controls the allowlist, define the status mapping per step name in the allowlist itself rather than relying on substring matching.

### R1-F2 [major]

The dispatcher lane's paths list `retry.ts`, `decide.ts`, `types.ts`, and `retry.test.ts` inside `services/gateway/src/services/project-manager/`. The PM loop's act phase is wired through `ActDeps` (loop.ts:17,26), and every decision kind that has a side-effect needs a handler in the act module. The `retry` decision (unparking a lane to its `parked_from` state) is a write action that requires an act handler, but `act.ts` is not in the lane's paths. If the unpark is done through the existing PM-agent GitHub writer or the ledger writer seam that is already wired, the plan should say so; if it needs a new act handler, the file is missing from the lane scope.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/loop.ts:10` — * `liveLoopDeps()` wires the production seams: the GitHub observer, safe-merge
 * (routes/cicd.ts — the only merge path), the pm-agent GitHub writer, the
 * Operator Chat Gate 2 poster, the PostgREST pm_lease, update-branch and the
 * ledger writer. No deploy, dispatch or VTID allocation seam exists.
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/loop.ts:17` — import type { ActDeps } from './act';
import type { PmObserver } from './observe';
import type { PmDecisionEmitter } from './emit';
import { summarizeDecision } from './emit';

export interface PmLoopDeps {
  observer?: PmObserver;
  emitter?: PmDecisionEmitter;
  /** The act seams; without them a `live` tick only decides. */
  act?: ActDeps;

Suggestion: Clarify whether the retry unpark uses the existing pm-agent GitHub writer seam (a commit that changes the lane state in the handoff file) or needs a new act handler. If the latter, add `act.ts` to the dispatcher lane's paths. If the former, state explicitly that the retry act is expressed as a pm-agent commit through the existing writer seam and that no new act handler is needed.

### R1-F3 [minor]

The plan says STAGING-VERIFY wiring will send results through the gateway route (`POST /api/v1/oasis/events`) with `GATEWAY_SERVICE_TOKEN`. Today record-oasis.sh (line 63-66) writes directly to PostgREST with a richer payload structure: it sets `topic`, `metadata` (with vtids, results array, production_commit, etc.), `role`, and `model` fields directly on the oasis_events row. The gateway route (events.ts:520-530) remaps field names (`type`→`topic`, `source`→`service`), hardcodes `role: 'CICD'` and `model: 'vtid-0416-governed-deploy'`, and accepts metadata only as `details`. The traceability and staging-verify-wiring lanes both modify the relevant files, but the plan doesn't mention how the rich STAGING-VERIFY metadata (especially `metadata.vtids`, `metadata.results[]`) is preserved through the gateway route schema.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/record-oasis.sh:33` — jq -c --arg run "${RUN_URL:-}" --arg workflow "${WORKFLOW:-STAGING-VERIFY.yml}" '{
      vtid: (.vtid // "BOOTSTRAP-STAGING-VERIFY"),
      topic: ("staging.verify." + .outcome),
      ...
      metadata: {
        env: "staging", service: .service, commit: .sha, outcome: .outcome,
        vtids: .vtids, run_url: $run, ...
      }
    }' "$RESULTS" > "$BODY_FILE"
  ...
curl -fsS -X POST "$SUPABASE_URL/rest/v1/oasis_events" \
    -H "Content-Type: application/json" -H "apikey: $SUPABASE_SVC" ...
- `exafyltd/vitana-platform:services/gateway/src/routes/events.ts:520` — const payload = {
        id: eventId,
        created_at: timestamp,
        vtid: body.vtid,
        topic: body.type,
        service: body.source,
        role: "CICD",
        model: "vtid-0416-governed-deploy",
        status: eventStatus,
        message: body.message,
        link: null,

Suggestion: Note in §4 or §9 (step event body) that the traceability lane must extend the gateway event schema to accept `metadata` (or map it to the DB's `metadata` column via `details`), and that the hardcoded `model` and `role` fields must be made configurable for delivery callers (e.g., accept `role` and `model` from the request body for authenticated callers).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
