# Sparring round 3 — escalated

Session: `12379be3-6ae6-4f7a-a93a-f79d41ce419a` · plan hash `c675ebe37b6d6d25f70db7bd14145652cfa42f93b50749fb2d989211a9064788`

## Summary

R2-F1 (types.ts missing status field) is correctly addressed in the revision. The change-1 predicate, the change-3 migration ordering, and the change-2/3 legacy rule are all consistent with the code I read. One new defect found in change 3: the `reclassified: false` marker set by the migration is never persisted, so the "checked at most once / no network call on a no-op push" guarantee is unenforceable and the plan's own test (b) will fail.

## Findings

### R3-F1 [major]

Change 3's legacy migration sets `cur.reclassified = false` when the live session does NOT match (an ok read, or round_cap_reached), but that flag is never written to state.json. In `step()` the migration is said to run 'right after cur is read and before retryInfra/replan are computed'. For a non-matching legacy entry (verdict 'escalated', infra=false, retryable=false, unchanged plan) both `retryInfra` and `replan` stay false, so control reaches the final `else` branch which returns `{ action: 'nothing_to_do', wrote }` at lines 210-211 — before the `write(statePath, ...)` at line 223. The mutated `cur.reclassified = false` is therefore discarded. On the very next push the migration re-runs `client.get(cur.id)` (a network call) because state.json still has no `reclassified` key. This defeats the plan's stated guards: 'each legacy session is checked at most once' and 'a normal no-op push makes no network call'. It also contradicts test (b), which asserts `reclassified: false stored`, so that test will fail unless the implementation adds an explicit state.json write on the non-matching path.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:186` — const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable;
const replan = cur && cur.verdict === 'escalated' && !cur.infra && state.sessions.length < MAX_SESSIONS && cur.plan_text_sha !== sha(planText);
if (!cur || retryInfra || replan) { ... } else if (cur.verdict === 'in_progress') { ... } else { return { action: 'nothing_to_do', wrote }; }
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:214` — const entry = state.sessions[state.sessions.length - 1];
const seen = entry.rounds ?? 0;
... 
write(statePath, `${JSON.stringify(state, null, 2)}\n`);

Suggestion: Specify that the migration persists `cur.reclassified` (and any other migrated fields) by writing state.json on the non-matching path before returning `nothing_to_do` — e.g. `write(statePath, JSON.stringify(state, null, 2))` immediately after setting the flag (and include the written path in `wrote`). The test (b) should assert the persisted state, and a test (c-style) should confirm that a second push with `reclassified` present performs zero `client.get` calls.

### R3-F2 [minor]

Change 3's trigger gate requires `infra === false && retryable === false`, but a legacy session escalated with `partner_output_invalid` (the nudge-exit case R1-F1) has `infra === true` already, because `partner_output_invalid` IS in INFRA_REASONS. For such an entry the gate `infra === false` is false, so the migration is skipped and that legacy session never gains `retryable: true`, meaning it never re-runs through the `retryInfra` path (which needs `infra && retryable`). The plan lists `partner_output_invalid` as a reclassifiable reason in change 2/3 but the migration precondition excludes it.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:32` — const INFRA_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded', 'partner_output_invalid'];
const RETRYABLE_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded'];
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:186` — const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable;

Suggestion: Reconcile the migration gate with the reason list: either run the migration when `verdict === 'escalated' && retryable === false` (dropping the `infra === false` condition, since a legacy `partner_output_invalid` entry already has infra true but retryable false), or explicitly document that the nudge-exit `partner_output_invalid` legacy sessions are intentionally excluded from the re-run and remove `partner_output_invalid` from change 2/3's reclassifiable reasons.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The revision now lists types.ts (ToolLogEntry gains status?: number) and correctly enumerates which github-tools.ts fail sites set status 0 (network catch block, no-token guard) versus none (invalid path, no pinned ref, not a readable file). Confirmed against the current code at github-tools.ts L131/L144/L198 and types.ts L78-84.
