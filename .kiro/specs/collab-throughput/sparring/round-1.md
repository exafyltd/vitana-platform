# Sparring round 1 — in_progress

Session: `2eacb48d-7f1f-43af-9d7f-d25383d7f654` · plan hash `cd017af999b1f78936f6dd6f0215bb5961201268beb1a903a6fe4d398f4ef558`

## Summary

The plan is well-structured, with accurate premises about the existing code. I verified the key code locations (collect(), submitPlannerRound, hasCodeAccess, PLAN-SPAR.yml Comment step, plans-spar.ts router) and all held. I found one major issue around Express route ordering for the proposed health endpoint, and two minor clarification gaps.

## Findings

### R1-F1 [major]

The proposed `GET /health` route on the plans-spar router will be swallowed by the existing `GET /:id` route unless it is registered before it. In `plans-spar.ts`, `GET /:id` is defined at line 66. Express matches routes in definition order, so `GET /health` registered after `GET /:id` would match with `req.params.id = 'health'`. The service validates ids against UUID_RE (line 41: `/^[0-9a-f]{8}-…$/i`), so the request would fail with a 400/404 instead of reaching the health handler. The plan does not specify route ordering.

- `exafyltd/vitana-platform:services/gateway/src/routes/plans-spar.ts:46` — router.get('/:id', requireServiceOrAdmin, async (req: Request, res: Response) => { ... getSparringSession(req.params.id, getDeps()) ... }
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:41` — const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Suggestion: The plan (or the spec's implementation guidance) must state that `router.get('/health', ...)` is registered BEFORE `router.get('/:id', ...)` in `createPlansSparRouter`. Add a Jest test that `GET /api/v1/plans/spar/health` hits the health handler, not the session-get handler.

### R1-F2 [minor]

Change D's concurrency cap ('at most PLAN_SPARRING_MAX_CONCURRENT_PASSES partner passes run at once per gateway task') does not specify the enforcement mechanism. The gateway has no existing concurrency control in `runPartnerPass` or the route handlers. The plan should state whether this is an in-process semaphore, a database advisory lock, or something else, because the choice affects behaviour under multi-task deployments and request timeouts.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:95` — export async function runPartnerPass(input: PartnerPassInput): Promise<PartnerPassResult> { const now = input.now ?? Date.now; const startedAt = now(); ... }
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:332` — export async function submitPlannerRound(id: string, body: unknown, deps: PlanSparringDeps): Promise<SparringSession> { ... const pass = await runPartnerPass({ ... }); ...

Suggestion: State explicitly that the cap is an in-process semaphore (or whatever it is). Note whether it is per-process or across ECS tasks, and what HTTP status (or delay) a queued request sees — a 429 vs. a held connection have different implications for the plan-spar.mjs client recovery logic.

### R1-F3 [minor]

Change B says `step()` will write the error report to `$RUNNER_TEMP/plan-spar-comment.md`, but `step()` has no access to `$RUNNER_TEMP` — it receives `{ dir, slug, baseSha, repo, client, allocate, now }`. The write would need to happen either in `main()` (which knows the env) based on the `{ action: 'responses_invalid', problems }` return, or a new parameter/output path must be threaded into `step()`. The plan should clarify which layer writes the comment file.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:166` — export async function step({ dir, slug, baseSha, repo, client, allocate = false, now = Date.now }) {
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:296` — async function main(argv) { const a = parseArgs(argv); ... const r = await step({ dir: a.dir, slug, baseSha: a['base-sha'], repo: a.repo, client, allocate: process.env.PLAN_SPAR_ALLOCATE === 'true' }); say(`✅ **plan-spar** — ${slug}: ${r.action}...`); return 0; }

Suggestion: Clarify that `main()` inspects the returned action and writes the comment file (or pass an output-path into `step()`). This keeps `step()` testable without filesystem side-effects outside its spec directory.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
