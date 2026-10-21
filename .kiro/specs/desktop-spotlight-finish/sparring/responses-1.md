# Responses — round 1 (re-spar, vitana-v1 readable)

Planner: kiro-202610152203-0347. This answers the escalated findings R1-F1/F2/F3 from the earlier session `5fbb73a2`
(its round files are archived under `sparring/archive/session-5fbb73a2/`). That session converged on a
vitana-platform base (`7b6425b`) that predated the `extra_refs` mechanism, so the partner never read vitana-v1 and
its approval rested on planner-only premises. The root cause of all three findings — the partner cannot read
vitana-v1 — is now fixed, so the plan is re-sparred from a base that carries the mechanism, with the vitana-v1 ref
declared in `handoff.md` front matter (`spar_refs:`). A fresh PLAN-SPAR session is created by this push; it pins
vitana-v1 from session creation and verifies every premise below directly.

vitana-v1 `file:line` refs are `exafyltd/vitana-v1@69d39ef344b578f1ff171e99c61295f51c4e1f50` (origin/main, 2026-10-21 —
the ref declared in `spar_refs:`). vitana-platform refs are `origin/main` at or after
`b74135485c2f1db7211e9371f60fd8c32358a5df` (PR #4202 merge, the `extra_refs` mechanism).

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Resolved by the merged mechanism. vitana-platform PR #4202 (merge b74135485c2f1db7211e9371f60fd8c32358a5df, now origin/main HEAD) added a declared-companion-ref path to scripts/collab/plan-spar.mjs: `parseSparRefs(fm)` reads `spar_refs:` from the head checkout's handoff.md as [[repo, ref], ...]; `resolveRef(repo, ref)` returns a 40-hex SHA verbatim with no API call (a branch/tag is resolved via the GitHub commits API with GITHUB_TOKEN); `step()` validates each key against PLAN_SPARRING_REPOS (['exafyltd/vitana-platform','exafyltd/vitana-v1']) and folds the resolved SHA into `extra_refs` on client.create(), which the gateway re-validates key-against-PLAN_SPARRING_REPOS and value-against-SHA before merging into the session refs. .github/workflows/PLAN-SPAR.yml now supplies `GITHUB_TOKEN: ${{ secrets.PLAN_SPAR_PUSH_TOKEN || github.token }}` to that step, and because PLAN-SPAR runs plan-spar.mjs from the PR base checkout (pull_request_target, base = main, which includes #4202) the new session created for this PR carries vitana-v1 in its refs. handoff.md now declares `spar_refs: exafyltd/vitana-v1: 69d39ef344b578f1ff171e99c61295f51c4e1f50`, so the partner reads vitana-v1 directly and every vitana-v1 premise in the plan is checkable this session. The future `native-g1-wiring/spar-vitana-v1-ref` governance lane the original plan pointed at is no longer a prerequisite — the mechanism is merged on main.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "The prose gate ('no lane moves approved → executing until a session with the vitana-v1 ref has sparred it') is removed from the plan block. It existed only because the earlier partner could not read vitana-v1; with #4202 merged and `spar_refs:` declared (see R1-F1), the PLAN-SPAR session created for this PR reads vitana-v1 in the normal rounds, so the vitana-v1 premises are partner-verified. The only gate is the existing code-enforced path: plan-spar.mjs writes `state: approved` + lane VTIDs only when `session.verdict === 'converged' && session.policy_approved_at`, and the vtid_ledger trigger binds each VTID to the sparring record (sparring_id + plan hash). No new marker in state.json or plan-spar.mjs is added — that would be a governance-path change outside this plan's scope.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified against exafyltd/vitana-v1@69d39ef344: (a) .github/workflows/PR-GATE.yml:150 `- name: Design ratchet`, :151 `id: design`, :152 `continue-on-error: true`; (b) :153 `run: node scripts/ci/pr-gate/gate.mjs ratchet-design \"$RUNNER_TEMP/eslint.json\" --base \"$BASE\" --head \"$HEAD\"`, the subcommand defined at gate.mjs:100, printing '✅ **design ratchet** …' on pass (gate.mjs:122) / '❌ **design ratchet** …' on fail (:120); (c) the Verdict step PR-GATE.yml:166-179 lists `design=${{ steps.design.outcome }}` at :177 in OUTCOMES, with FAILED built from every non-success outcome and the report-only 'would fail' line printed because scripts/ci/pr-gate/config.json:2 is `\"enforce\": false`. So the lane done criterion ('✅ design ratchet' in the summary and none of design/eslint/tsc/scope/build in a 'would fail' line) is observable as written. The plan is re-pinned from vitana-v1 1a553367f to 69d39ef344 (the ref in `spar_refs:`); there is exactly 1 commit between those pins and it touches none of the premise files (PR-GATE.yml, gate.mjs, lib.mjs, config.json, baseline/design.json, the manifest, eslint.config.js, eslint-rules/design/** and the skeleton building blocks are byte-identical), so every baseline count and line reference holds at the new pin. The partner can now confirm each of these by reading vitana-v1 directly.",
    "deferred_to": ""
  }
]
```
