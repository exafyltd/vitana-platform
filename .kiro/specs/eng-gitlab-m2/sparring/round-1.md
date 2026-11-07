# Sparring round 1 — in_progress

Session: `af19bcd5-1194-4347-a876-b6c23a2eb855` · plan hash `79ebeaf9d12d5277a8464de1b9fe0f9a77afc00913dbd104979d9757c23b6c7f`

## Summary

The plan is thorough and well-structured for milestone 2, correctly identifying the Free-tier constraints and building around them. Most premises about the existing codebase hold. However, there is one significant factual error about OASIS event topic names that would cause a type error at build time, and a couple of minor issues worth addressing.

## Findings

### R1-F1 [major]

The plan states (§3.5) that GitLab merge_request and pipeline events will be mapped to 'the neutral topics that already drive the VTID lifecycle (`cicd.pr.created`, `cicd.merge.success`, `cicd.ci.failed`)'. Of these three, only `cicd.merge.success` actually exists in `CicdEventType`. There is no `cicd.pr.created` and no `cicd.ci.failed` in the type union. The closest existing topics are `cicd.github.create_pr.requested/succeeded/failed` and `dev_autopilot.execution.ci_failed`, which are semantically different. Adding a string literal not in the union to an OASIS emit call will fail TypeScript compilation.

- `exafyltd/vitana-platform:services/gateway/src/types/cicd.ts:139` — export type CicdEventType =
  ...
  | 'cicd.merge.requested'
  | 'cicd.merge.success'
  | 'cicd.merge.failed'
  (no cicd.pr.created or cicd.ci.failed anywhere in the union)
- `exafyltd/vitana-platform:services/gateway/src/types/cicd.ts:174` — | 'cicd.github.create_pr.requested'
    | 'cicd.github.create_pr.succeeded'
    | 'cicd.github.create_pr.failed'
    | 'cicd.github.create_pr.skipped_existing'

Suggestion: Correct the plan to either (a) name the exact existing topics that will be reused (e.g. `cicd.merge.success` is real; there is no PR-created or CI-failed equivalent), or (b) explicitly list all new topic literals that will be added to `CicdEventType` for the GitLab webhook mapper. The plan already says 'new `scm.gitlab.*` topics for the rest, added to `CicdEventType`' — extend that to cover all mapped events, not just 'the rest'.

### R1-F2 [minor]

The plan says `verifySvix` will be used to verify GitLab's Standard Webhooks signature with headers `webhook-id`, `webhook-timestamp`, `webhook-signature`. The existing `verifySvix` function takes `headers: { id?, timestamp?, signature? }` using Svix's own header prefix convention (`svix-id`, etc.). While the underlying HMAC algorithm is identical, the plan should explicitly note that the route handler must map header names from `webhook-*` to the generic fields, since the function was originally written for the Svix/Vital vendor integration and the header names differ.

- `exafyltd/vitana-platform:services/gateway/src/connectors/runtime/webhook-signature.ts:59` — export function verifySvix(
  raw: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string | undefined,
  nowMs: number = Date.now(),
): WebhookVerdict {

Suggestion: Add a note in §3.5 that the route handler maps `webhook-id` → `id`, `webhook-timestamp` → `timestamp`, `webhook-signature` → `signature` before calling `verifySvix`. Consider adding a thin `verifyStandardWebhook` wrapper that does this mapping, keeping the route code self-documenting.

### R1-F3 [minor]

The plan says `checksVerdict` from `land-guard.mjs` will be reused unchanged for GitLab pipeline jobs. This function expects GitHub check-run objects with `status: 'completed'` and `conclusion` from `OK_CONCLUSIONS` ('success', 'skipped', 'neutral'). GitLab CI jobs use a different status model (created/pending/running/failed/success/canceled/skipped/manual) with no separate 'conclusion' field. The plan mentions mapping ('an `allow_failure` failure counts as neutral') but does not specify the complete mapping table, which is needed for test coverage.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:32` — export const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:85` — export function checksVerdict(runs) {
    if (!runs.length) return { state: 'pending', detail: 'no check runs yet' };
    const latest = new Map();
    for (const r of runs) {
      const prev = latest.get(r.name);
      const key = (x) => `${x.started_at || '9999'}|${String(x.id || 0).padStart(20, '0')}`;
      if (!prev || key(r) >= key(prev)) latest.set(r.name, r);
    }
    const rows = [...latest.values()];
    const failed = rows.filter((r) => r.status === 'completed' && !OK_CONCLUSIONS.has(r.conclusion));
    if (failed.length) return { state: 'fail', detail: failed.map((r) => `${r.name}=${r.conclusion}`).join(', ') };
    const pending = runs.filter((r) => r.status !== 'completed');
    if (pending.length) return { state: 'pending', detail: pending.map((r) => `${r.name}=${r.status}`).join(', ') };
    return { state: 'pass', detail: `${rows.length} checks green` };

Suggestion: Add the explicit GitLab-to-GitHub-checkrun mapping table to §3.4 so it can be tested: e.g. GitLab `success` → `{status:'completed', conclusion:'success'}`, `failed` with `allow_failure` → `{status:'completed', conclusion:'neutral'}`, `failed` → `{status:'completed', conclusion:'failure'}`, `running/pending/created` → `{status:'in_progress'}`, `canceled` → `{status:'completed', conclusion:'cancelled'}`, `skipped` → `{status:'completed', conclusion:'skipped'}`, `manual` → (how handled?). The merge-bot tests in §5 should assert this mapping.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
