# Sparring round 1 — in_progress

Session: `5fbb73a2-eba8-4ea2-8f51-05767b2a7bd2` · plan hash `2f479af2f0878f55f1ebf4870c9558aad162c05c4965ecd71d7c76e646bdbd9a`

## Summary

The plan is structurally well-designed for a large design-system cleanup, but it contains a blocker-class governance gap and a major enforcement gap, both centred on the same root cause: `plan-spar.mjs` does not pass `extra_refs` to the gateway, so vitana-v1 is inaccessible in every sparring session this workflow creates. The plan acknowledges this and proposes a future governance lane (`native-g1-wiring/spar-vitana-v1-ref`) as the fix, but that lane has no spec, no code, and no SHA-sourcing mechanism anywhere in the repo. Until that chain is fully implemented and merged, the plan's own gating guarantee ("no lane moves approved → executing until a vitana-v1-ref session has sparred it") cannot be honoured, and every one of the ~20 specific vitana-v1 premises embedded in the plan remains unverifiable. A second, independent major finding is that even if a vitana-v1 session eventually ran, there is no code hook that would block VTID allocation or lane approval from proceeding without it.

## Findings

### R1-F1 [blocker]

`plan-spar.mjs` does not send `extra_refs` for vitana-v1, and the entire chain needed to ever do so is unimplemented. The gateway API does accept `extra_refs` (plan-sparring-service.ts:92, `extra_refs?: Record<string, string>`) and vitana-v1 is in the allowed-repos enum (github-tools.ts:21, `PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1']`). But plan-spar.mjs line 192-194 passes only `{ plan_text, producer, change_class, base_ref, repo, approval_policy }` — no `extra_refs`. The gateway therefore builds `refs = { 'exafyltd/vitana-platform': baseSha }` (plan-sparring-service.ts:266) and the partner gets the 'no pinned ref for exafyltd/vitana-v1' error seen in this session. Three further pieces of the chain are also absent: (1) the `native-g1-wiring/spar-vitana-v1-ref` governance lane that the plan says will add the feature has no entry in `.kiro/specs` and zero code-search hits; (2) `PLAN-SPAR.yml` line 81 hard-codes `--repo "${{ github.repository }}"` and passes only `--base-sha "$BASE_SHA"` (the vitana-platform base SHA) — it has no mechanism to source or forward a vitana-v1 commit SHA; (3) plan-spar.mjs has no argument or logic to accept a secondary repo SHA. The plan asserts this chain will be built before any lane executes, but provides no specification for how PLAN-SPAR.yml obtains the vitana-v1 SHA or how plan-spar.mjs exposes it to the gateway. Because all code premises in this plan are in vitana-v1 and none can be read, the sparring session cannot discharge its governance obligation regardless of how many rounds it runs.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:192` — session = await client.create({ plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY, });
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:86` — export interface CreateInput { ... extra_refs?: Record<string, string>; ...
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:266` — const refs: Record<string, string> = { ...(input.extra_refs ?? {}), [input.repo as string]: input.base_ref };
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:21` — export const PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'] as const;
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:79` — node base/scripts/collab/plan-spar.mjs --dir head --base-sha "$BASE_SHA" --repo "${{ github.repository }}" --changed ...
- `exafyltd/vitana-platform:.kiro/specs` — directory listing shows: claude-sessions-handover, health-native, life-timeline, multi-tenant, new-member-welcome, pm-agent, profile-vitana-cards — no native-g1-wiring entry

Suggestion: The plan must either (a) fully specify the `native-g1-wiring/spar-vitana-v1-ref` governance lane — what changes to plan-spar.mjs (`--extra-refs` flag or plan-text parsing), what changes to PLAN-SPAR.yml (how to source the vitana-v1 SHA, e.g. a repository variable or a fetch step), and its own sparring/approval path — and make that lane a prerequisite for this plan's approval; or (b) move the spec and its code into vitana-v1, where PLAN-SPAR would run natively and `--repo exafyltd/vitana-v1` would pin the correct repo without any extra_refs plumbing.

### R1-F2 [major]

The plan's sole guard against premature execution — 'no lane of this spec moves `approved → executing` until a session with the vitana-v1 ref has sparred it' — is a prose rule with no code enforcement. `plan-spar.mjs` writes `state: approved, next_actor: kiro` (ALLOCATE=true) or `state: sparred, next_actor: claude` (ALLOCATE=false) on convergence without any check that a vitana-v1-ref session has been completed. With the current ALLOCATE=false posture, Claude Code is handed `next_actor` and expected to follow the prose instruction before allocating VTIDs. Nothing in plan-spar.mjs, PLAN-SPAR.yml, or queue.mjs checks for a companion session record before writing lane approvals. The plan-spar.test.mjs confirms the converged path writes `state: approved, next_actor: kiro` and allocates VTIDs immediately (lines 112-115) without any secondary-session gate.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:228` — if (session.verdict === 'converged' && session.policy_approved_at) { ... write(handoffPath, ... state: approved ? 'approved' : 'sparred', next_actor: approved ? 'kiro' : 'claude' ...)
- `exafyltd/vitana-platform:scripts/collab/plan-spar.test.mjs:112` — assert.equal(h.state, 'approved'); assert.equal(h.next_actor, 'kiro'); assert.deepEqual(h.vtids, ['VTID-09001', 'VTID-09002']);
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:40` — if: vars.PLAN_SPAR_ENABLED == 'true' && github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.event.pull_request.title, 'plan(')

Suggestion: Either (a) add a machine-readable marker to the plan's state.json (e.g., `vitana_v1_session_id`) that plan-spar.mjs checks before writing `approved` or allocating VTIDs, so the gate is code-enforced rather than prose-enforced; or (b) accept this as a process control and explicitly document in `handoff.md` the mandatory checklist Claude must satisfy before calling `vtid/allocate` — including quoting the vitana-v1 session ID and its convergence verdict.

### R1-F3 [major]

The lane done criterion 'PR-GATE summary shows ✅ design ratchet and `design`, `eslint`, `tsc`, `scope` and `build` are absent from any would-fail line' depends on vitana-v1's PR-GATE.yml having a named 'Design ratchet' step at lines 150-153 and a Verdict step at lines 181-190. Vitana-platform's PR-GATE.yml is 145 lines total and has no design-ratchet step at all (confirmed by reading the full file); its Verdict step is at lines 104-122. The plan explicitly states these line references are for vitana-v1's PR-GATE.yml. Because vitana-v1 cannot be read in this session (consequence of R1-F1), it is impossible to verify whether the step name, its `continue-on-error` flag, and its inclusion in the Verdict OUTCOMES string are correctly described. If the step does not exist or is named differently in vitana-v1, every reviewer checking for '✅ design ratchet' in the PR-GATE summary will be looking for a signal that never appears, silently passing lanes that failed the design check.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:1` — Full file is 145 lines; steps are: Gate self-test, Live PR title, Kiro steering, Collab handoff, Scope guard, Sparring record, Test-weakening guard, Gateway deps, Red→green proof, Verdict (lines 104-122). No 'Design ratchet' step exists.
- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:104` — - name: Verdict ... OUTCOMES: scope=... kiro-steering=... sparring=... weakening=... red-green=...
- `exafyltd/vitana-platform:scripts/ci/pr-gate/gate.mjs:50` — const checks = { scope(), sparring(), weakening(), 'ratchet-tsc'(), 'ratchet-eslint'(), 'baseline-tsc'(), 'baseline-eslint'(), 'red-green'(), async migrations() ... } — no ratchet-design or baseline-design command

Suggestion: Before this plan can converge, a vitana-v1-ref session (once R1-F1 is resolved) must read vitana-v1's `.github/workflows/PR-GATE.yml` and confirm: (a) a step named exactly 'Design ratchet' exists at or near line 150; (b) it runs `gate.mjs ratchet-design`; (c) it appears in the Verdict OUTCOMES string so its failure is captured in the 'would fail' line. Until confirmed, the done criterion for every lane is unverifiable.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
