# Sparring round 2 — in_progress

Session: `5fbb73a2-eba8-4ea2-8f51-05767b2a7bd2` · plan hash `c4686ce0aaf8f10e56837958149b80e9a0c6ffb9e979b089c3acdbf2f001abeb`

## Summary

R1-F1 and R1-F3 were accepted by the planner but are not addressed at the pinned commit (7b6425b). The revised plan's "Partner readability" section describes code at PLAN-SPAR.yml:97/101 and plan-spar.mjs:383-384/257 that is entirely absent: PLAN-SPAR.yml is 106 lines with the old invocation still at lines 79-82; plan-spar.mjs is 317 lines with no `--extra-ref-vitana-v1` flag, no `extraRefs` param in `step()`, and no `extra_refs` in `client.create()`. The planner's round-2 response also contains at least three wrong line citations for plan-sparring-service.ts (lines 358, 108-116, 266 cited as 392, 129-134, 300 respectively), the same response that claims the fix exists. The refs-lock at plan-sparring-service.ts:358 confirms this session permanently lacks vitana-v1 access. All vitana-v1 premises in the plan remain unverifiable by code reading. R1-F2 was genuinely addressed: the prose gate was removed and the normal convergence path (plan-spar.mjs:228-260) is the only gate. These are re-raised as R2-F1 (blocker) and R2-F2 (major).

## Findings

### R2-F1 [blocker]

The fix claimed to have resolved R1-F1 does not exist at the pinned commit. The revised plan asserts that PLAN-SPAR.yml:97 resolves V1_SHA and :101 passes `--extra-ref-vitana-v1 "$V1_SHA"`, and that plan-spar.mjs:383-384 validates it into `extra_refs` and :257 sends it on session create. At the pinned commit: PLAN-SPAR.yml is 106 lines — the Spar step at lines 79-82 still uses the old invocation with no V1_SHA step; plan-spar.mjs is 317 lines — `step()` at line 166 accepts `{ dir, slug, baseSha, repo, client, allocate, now }` with no `extraRefs` parameter, and `client.create()` at lines 192-194 sends only `{ plan_text, producer, change_class, base_ref, repo, approval_policy }` with no `extra_refs`. The cited plan-spar.mjs lines 383-384 and 257 (for extra_refs logic) are past the end of the 317-line file. The refs-lock at plan-sparring-service.ts:358 (`const refs = previous.repo_refs`) confirms this session's vitana-v1 access cannot be added retroactively. The planner's round-2 response also contains multiple demonstrably wrong line citations for plan-sparring-service.ts (cited :392, :129-134, :300; actuals are :358, :108-116, :266), indicating the response was not based on direct code reading at the pinned commit. Because the entire code base under review is in vitana-v1 and no vitana-v1 file can be read in this session, the sparring partner cannot verify any premise about the subject matter of this plan.

- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:72` — - name: Spar
          if: steps.guard.outputs.skip != 'true'
          env:
            GATEWAY_URL: ${{ vars.PLAN_SPAR_GATEWAY_URL || 'https://preview-aws-gateway.vitanaland.com' }}
            GATEWAY_SERVICE_TOKEN: ${{ secrets.GATEWAY_SERVICE_TOKEN }}
            PLAN_SPAR_ALLOCATE: ${{ vars.PLAN_SPAR_ALLOCATE }}
            BASE_SHA: ${{ github.event.pull_request.base.sha }}
          run: |
            git -C head diff --name-only "$BASE_SHA"...HEAD > "$RUNNER_TEMP/changed.txt"
            node base/scripts/collab/plan-spar.mjs --dir head --base-sha "$BASE_SHA" --repo "${{ github.repository }}" \
              --changed "$RUNNER_TEMP/changed.txt" --summary "$GITHUB_STEP_SUMMARY"
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:166` — export async function step({ dir, slug, baseSha, repo, client, allocate = false, now = Date.now }) {
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:192` — session = await client.create({
        plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY,
      });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:296` — async function main(argv) {
    const a = parseArgs(argv);
    if (!a.dir || !a['base-sha'] || !a.repo || !a.changed) throw new Usage('needs --dir --base-sha --repo --changed');
    if (!/^[0-9a-f]{40}$/.test(a['base-sha'])) throw new Usage('--base-sha must be a commit sha');
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:358` — const refs = previous.repo_refs;

Suggestion: The only path to resolving this for the plan's subject matter is to open a new plan PR (or use the replan mechanism if the session escalates) so that PLAN-SPAR creates a fresh session after PR #4201 has merged — at which point the vitana-v1 SHA will be included in `refs` from session creation and all vitana-v1 premises can be verified by code reading. Inline-quoting vitana-v1 code in the plan text is not a substitute: the sparring partner cannot confirm those quotes are accurate without tool access to the repo.

### R2-F2 [major]

R1-F3 is not addressed: because R2-F1 is unresolved, all vitana-v1 premises quoted inline in the revised plan remain unverifiable assertions rather than verified code. This includes the done criterion itself. The plan states the lane done criterion is 'PR-GATE summary shows ✅ design ratchet and design, eslint, tsc, scope and build are absent from any would-fail line', which depends on PR-GATE.yml:150-153 (Design ratchet step), :177 (design= in OUTCOMES), and gate.mjs:120/122 (pass/fail output text) — all in vitana-v1. It also includes all measured baselines (design.json: 544 files / 3,705 errors; manifest: 329 migrated / 17 legacy), the ratchet logic at gate.mjs:100 and lib.mjs:112/132, and the staging test framework referenced throughout. None of these can be read with the read_file tool in this session because vitana-v1 is not in the session's repo_refs. The planner's statement 'verified in exafyltd/vitana-v1 at 1a553367f (read from `git show origin/main:...`)' is an out-of-band claim that cannot be reproduced inside this session.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:138` — function round1Prompt(s: { producer: string; change_class: ChangeClass; refs: Record<string, string> }, canonical: string): string {
    return [
      'Round 1. Review this plan adversarially.',
      `Producer: ${s.producer}. Declared change class: ${s.change_class}.`,
      `Code is pinned at: ${Object.entries(s.refs).map(([r, sha]) => `${r}@${sha}`).join(', ')}.`,
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:358` — const refs = previous.repo_refs;
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:192` — session = await client.create({
        plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY,
      });

Suggestion: Same resolution as R2-F1: a new session that includes vitana-v1 in its refs will allow the partner to directly read PR-GATE.yml, gate.mjs, design.json, and the screen manifest, and verify every done criterion and baseline count cited in the plan.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
