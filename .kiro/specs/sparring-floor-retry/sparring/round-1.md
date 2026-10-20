# Sparring round 1 — in_progress

Session: `12379be3-6ae6-4f7a-a93a-f79d41ce419a` · plan hash `9d4a5de6a1b223603e9d3d13ad4690360aef74851ea341f15685ade35bd209b1`

## Summary

The plan correctly diagnoses the outage (broken-but-set token passes hasCodeAccess, floors fail, evidence_floor_not_met is neither infra nor retryable, so the 10 legacy sessions are stuck) and the two-pronged fix (service dedup re-run + CLI state migration) is coherent and correctly coordinated. I verified the core premises against the code and they all hold. My findings concern three gaps: (1) the nudge exit in partner.ts (L177) is not covered by change 1, so an all-failed-read pass that ends in text still escalates partner_output_invalid (non-retryable) rather than code_access_unavailable; (2) the codeAccessFailed predicate is imprecise in both directions; (3) the migration must run before the retryInfra/replan computation, and the plan's ordering is underspecified.

## Findings

### R1-F1 [major]

Change 1 only re-routes the invalid-submission exit (partner.ts L242-245) and the turn-cap exit (L250), but not the nudge exit at L177. A pass whose reads all fail (toolLog non-empty and every entry ok:false) that then answers in plain text twice hits `fail('partner_output_invalid', ...)` at L177 without any codeAccessFailed check, so it still escalates partner_output_invalid. partner_output_invalid is in INFRA_REASONS but NOT in RETRYABLE_REASONS, so such a session is handed to Claude and never auto-retried — the exact mislabel the plan's Goal 1 says it is fixing ('whatever the floor check said').

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:176` — if (calls.length === 0) { if (nudged) return fail('partner_output_invalid', 'partner ended its turn without calling submit_review');
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:32` — const INFRA_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded', 'partner_output_invalid']; const RETRYABLE_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded'];

Suggestion: Apply the same codeAccessFailed check at the L177 nudge exit (return code_access_unavailable when toolLog.length > 0 and every entry !ok), or at minimum confirm and document why that exit is intentionally excluded from Goal 1.

### R1-F2 [minor]

The codeAccessFailed predicate (`toolLog.length > 0 && toolLog.every((e) => !e.ok)`) is imprecise in both directions. (a) list_dir and search set ok:true on success, but the evidence floor only ever requires a successful read_file (checkEvidence → citesReadFile counts only name==='read_file' && ok). So a pass where the contents endpoint is down but /search/code (same bearer token) or list_dir still returns ok:true would have an ok:true entry and be mislabeled evidence_floor_not_met, escaping reclassification. (b) read_file returns ok:false for 'not a readable file (directory/submodule/>1MB)' and 'invalid path', which are code-access SUCCESSES with a wrong target, not outages; a partner that only makes such calls (no list_dir/search) would have every entry ok:false and be relabelled code_access_unavailable, turning a genuine partner problem into an endlessly-retryable infra signal.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:157` — return { result: clip(...), isError: false, log: { ...base, path, ok: true } };
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:146` — if (body?.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') { return fail(`${path} is not a readable file (directory, submodule or >1MB)`, { path });
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner-prompt.ts:166` — export function citesReadFile(e: EvidenceRef, reads: ToolLogEntry[]): boolean { return reads.some((r) => r.name === 'read_file' && r.ok && r.repo === e.repo && r.path === e.path);

Suggestion: Define codeAccessFailed over read_file results specifically (e.g. at least one read_file attempt AND zero read_file attempts with ok:true), and optionally exclude ok:false entries whose error indicates a valid-but-unusable target rather than an auth/network failure. Document the residual single-token assumption.

### R1-F3 [minor]

The legacy-state migration in change 3 mutates cur.infra/cur.retryable to true and relies on 'the existing retryInfra path' to pop and re-create, but retryInfra and replan are computed at lines 186-187 BEFORE any per-entry migration (cur is read at line 180). If the migration is inserted after those lines (which the plan's phrasing 'the existing retryInfra path then pops it' invites), the post-mutation flags are never re-read and the pop/create never fires, so the legacy entries stay stuck despite the migration setting the flags.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:186` — const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable; const replan = cur && cur.verdict === 'escalated' && !cur.infra && ... if (!cur || retryInfra || replan) {

Suggestion: Specify that the migration runs BEFORE the retryInfra/replan computation (or recompute retryInfra/replan after the mutation), and add a test that the non-reclassified legacy entry actually triggers a create (not just that the flags are set).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
