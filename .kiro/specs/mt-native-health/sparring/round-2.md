# Sparring round 2 — in_progress

Session: `fca982e6-f8a0-4fc9-8e6e-78d23ba39b48` · plan hash `6cb3fcd7203842adfa61be98bea9c7c2eeaedbcb3d2e79fc6ebd1f7551b7cb3b`

## Summary

The revised plan is materially stronger: R1-F1 (per-tenant copy out of scope), R1-F2 (flag-flip is a real change for dual members), R1-F3 (isHealthTable import + committed inventory), and R1-F4 (writers+readers convert together behind one flag) are all genuinely addressed with corrected wording and code-backed evidence. The four findings were all accepted, none rejected/deferred, so no acknowledgement dispute is needed. I verified the core premises against the pinned code: the token fetch tenant filter, the `limit(1).maybeSingle()` session fallback, the five health reader/writer sites, the one-row-per-notification insert, and the user-keyed wearable tables all hold as described. One new gap remains: a non-user-scoped health reader (`fetchVitanaIndexScoreForDate`, date-only `.single()`) is classified as a convert-to-`healthDb` target even though `healthDb(userId)` is user-keyed and cannot inject a tenant into a query with no user_id — the plan flags this function as the reason the lint is warning-only but never resolves its disposition.

## Findings

### R2-F1 [major]

The health-tenant-accessor lane classifies `vitana_index_scores` as '(a) convert-to-healthDb ... written/read with a session tenant', but `fetchVitanaIndexScoreForDate` in health-repository.ts reads `vitana_index_scores` filtered ONLY by `date` with `.single()` — it has no `user_id` and no `tenant_id` parameter at all. A user-keyed accessor `healthDb(userId)` cannot inject a frozen home tenant into a query that has no user context, and `.single()` asserts one global row per date, which is incompatible with per-user tenancy. The plan cites this exact function as the reason the lint must ship warning-only ('e.g. health-repository.ts:51 fetchVitanaIndexScoreForDate reads vitana_index_scores by date only') yet gives no disposition for it: it is neither reclassified as a service-role/compute job (category c), nor given a signature change to take userId, nor removed. As written, the conversion inventory's '(a) ... read with a session tenant' description is factually wrong for this reader, and the accessor design leaves its tenant scoping unresolved.

- `exafyltd/vitana-platform:services/gateway/src/routes/health-repository.ts:51` — export async function fetchVitanaIndexScoreForDate(sb: SupabaseClient, date: string) { return sb.from('vitana_index_scores').select('*').eq('date', date).single(); }

Suggestion: Give `fetchVitanaIndexScoreForDate` an explicit disposition in the inventory: either (a) reclassify it as a service-role/compute-path reader (category c) if it is only reached from the daily recompute/compute pipeline, or (b) change its signature to `fetchVitanaIndexScoreForDate(sb, userId, date)` and filter by `user_id` (the same pattern as `fetchVitanaIndexScoreForDate(tenantId, userId, date)` already in health-action-initiative-repository.ts:53), or (c) state it is out of scope. Without one of these, the '(a) convert-to-healthDb' classification is unreachable and the inventory will not match the code the accessor lane actually produces.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
