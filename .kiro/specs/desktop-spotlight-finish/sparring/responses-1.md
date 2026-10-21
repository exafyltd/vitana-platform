# Responses — round 1 (session 5fbb73a2)

Planner: kiro-202610182052-5ce2 (holder of `desktop-spotlight-finish/_plan`). This file answers round 1 of session
`5fbb73a2-eba8-4ea2-8f51-05767b2a7bd2` (`sparring/round-1.md`, plan hash 2f479af2…). The answers to round 1 of the
earlier, infra-retried session are in git history (commit e881542bd). vitana-v1 `file:line` refs below are
`exafyltd/vitana-v1@1a553367ff6622cc746c4720c6e3558e691b34dc` (origin/main, 2026-10-21); vitana-platform refs are
origin/main bd7e8e979.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Resolved by the merged mechanism, which this round's evidence predates. vitana-platform PR #4201 (VTID-05215, merge fa73aabd0, merged 2026-10-19T20:09:22Z) implemented the native-g1-wiring/spar-vitana-v1-ref lane: .github/workflows/PLAN-SPAR.yml:97 resolves `V1_SHA=$(gh api repos/exafyltd/vitana-v1/commits/main --jq .sha)`, :98 writes it to the step summary, :101 passes `${V1_SHA:+--extra-ref-vitana-v1 \"$V1_SHA\"}` to plan-spar.mjs; scripts/collab/plan-spar.mjs:10-11 documents the flag, :383-384 validates a 40-hex SHA into `{ 'exafyltd/vitana-v1': v1Sha }`, :385 passes it to step(), and :257 spreads it as `extra_refs` into client.create(); the gateway merges it into the session refs (plan-sparring-service.ts:300) after validating each key against PLAN_SPARRING_REPOS (:129-134). The plan block now cites that mechanism instead of a future lane. Note for this round: session 5fbb73a2 was created by the push of b5db825e9 at 2026-10-19T17:29:46Z, before #4201 merged, so its refs are vitana-platform only and later rounds reuse them (plan-sparring-service.ts:392 `const refs = previous.repo_refs`). To make the vitana-v1 premises checkable inside this session anyway, the plan block now quotes each one with its line at the new pin (PR-GATE.yml:150-153 step text, :166-179 OUTCOMES, gate.mjs:120/:122 output text). Any new session PLAN-SPAR opens for this plan carries the vitana-v1 ref.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "The prose gate ('no lane moves approved → executing until a session with the vitana-v1 ref has sparred it') is removed from the plan block. It existed only because the partner could not read vitana-v1; with #4201 merged (see R1-F1) a PLAN-SPAR session is created with the vitana-v1 ref, so the partner verifies vitana-v1 premises in the normal sparring rounds and the existing code-enforced path is the only gate: plan-spar.mjs writes approved/VTIDs only when `session.verdict === 'converged' && session.policy_approved_at`, and the vtid_ledger trigger checks the sparring record. No new marker in state.json or plan-spar.mjs is needed, and none is added (that would be a governance-path change outside this plan).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified in exafyltd/vitana-v1 at 1a553367f (read from `git show origin/main:.github/workflows/PR-GATE.yml` and `scripts/ci/pr-gate/gate.mjs`): (a) PR-GATE.yml:150 `- name: Design ratchet`, :151 `id: design`, :152 `continue-on-error: true`; (b) :153 `run: node scripts/ci/pr-gate/gate.mjs ratchet-design \"$RUNNER_TEMP/eslint.json\" --base \"$BASE\" --head \"$HEAD\"`, the subcommand defined at gate.mjs:100 (`'ratchet-design'() {`), which prints `✅ **design ratchet** (baseline: …) — no file gained design violations` on pass (gate.mjs:122) and `❌ **design ratchet** …` on fail (:120); (c) the Verdict step PR-GATE.yml:166-179 lists `design=${{ steps.design.outcome }}` at :177 in OUTCOMES, :181 builds FAILED from every non-success outcome, :182 reads config.json enforce, :189-190 print 'PR-GATE (report-only) would fail: $FAILED'. scripts/ci/pr-gate/config.json:2 is `\"enforce\": false`. So the done criterion ('✅ design ratchet' in the summary and none of design/eslint/tsc/scope/build in a 'would fail' line) is observable as written. The 704b5def4 line pins are unchanged at 1a553367f (`git diff 704b5def4 origin/main` is empty for PR-GATE.yml, scripts/ci/pr-gate/**, eslint.config.js, eslint-rules/design/**, src/design/**, SPOTLIGHT_RULES.md and the skeleton/vcard files); the plan block is re-pinned to 1a553367f, with the Verdict range corrected from :181-190 to :166-190 and the step's id/run/OUTCOMES lines quoted.",
    "deferred_to": ""
  }
]
```
