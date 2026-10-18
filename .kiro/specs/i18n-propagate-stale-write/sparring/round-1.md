# Sparring round 1 — in_progress

Session: `53dfe2bf-6ce3-46cf-8b20-13314324e497` · plan hash `a5eec78dc25bf35812403f59d85584158d2b5d83f87c7850c0022dc0bffbdc23`

## Summary

The plan targets vitana-v1 exclusively, but this sparring session has no pinned ref for vitana-v1 and search returns 403. Consequently, none of the plan's specific code premises (line numbers in I18N-PROPAGATE.yml, i18n-check.yml filter paths, test file patterns) can be verified against actual source. Three governance premises were verified against vitana-platform. Two substantive findings are raised beyond the unverifiable-premises issue.

## Findings

### R1-F1 [blocker]

Every specific code premise in this plan refers to vitana-v1 (I18N-PROPAGATE.yml lines 181, 220-223, 232, 245-246, 261-265, 162; i18n-check.yml filter; scripts/ci/pr-gate/__tests__/*.test.mjs pattern), but the sparring session has no pinned ref for vitana-v1 and search returns 403. The sparring protocol requires verifying at least 3 premises against code via read_file — zero of these can be verified. The plan may be entirely correct, but it has not been adversarially checked against the target codebase.

- `exafyltd/vitana-platform:CLAUDE.md:486` — The partner is independent and adversarial. It sees the plan and the code, never the planner's reasoning; it verifies the plan's premises against the code (`file:line`) and its findings are kept verbatim.

Suggestion: Re-run the sparring session with vitana-v1 pinned at the commit the plan references (5c4632ea9 or current main), so the partner can verify the workflow line numbers, the cp -r step, the i18n-check filter, the test pattern, and any other code-level premise. Without this, the sparring gate is not met.

### R1-F2 [major]

The plan's push loop for collect ('fetch → reset --hard origin/<ref> → script → commit → push, 5 attempts, then red') does not address what happens if the 3-way merge script itself is non-deterministic across retries due to 'ours' changing between iterations. Specifically: if a human pushes a commit between retry N's fetch and push, retry N+1 sees a different 'ours'. The plan says 'both changed → ours, plus ::warning::' — so the set of warnings (and the final file content) can change between retries. This is fine if each retry is self-contained, but the plan should confirm that the script produces no side effects (no partial writes, no appended warnings from prior attempts) that accumulate across retries. The plan also doesn't specify how many retries 'pivot' gets or what happens after exhausting them.

- `exafyltd/vitana-platform:CLAUDE.md:168` — Always fail loudly if a required invariant is missing.

Suggestion: Explicitly state in the plan that each retry iteration of the push loop starts from a clean working tree (reset --hard), so there are no accumulated side effects from prior attempts. Specify the retry count and failure mode for 'pivot' the same way collect's is specified (5 attempts, then red). Document that warnings are emitted per attempt (the last successful push's log is the one that matters).

### R1-F3 [minor]

The plan's test scenarios cover key-level merge behavior thoroughly but do not include a scenario for a file that exists only in 'ours' (a new locale shard added by a human after the fan-out's base SHA). The 3-way merge description says 'bot unchanged → ours' per leaf key, but a file absent from both 'base' and 'bot' has no keys in those sides at all. The script's behavior for this edge case should be specified and tested — presumably 'leave it alone', but the plan is silent.

- `exafyltd/vitana-platform:CLAUDE.md:168` — Always fail loudly if a required invariant is missing.

Suggestion: Add a test scenario: 'human adds a brand-new shard file after base SHA; bot has no artifact for it → file preserved unchanged'. Confirm the script only processes files present in the bot artifact directory, and therefore never touches files it didn't generate.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
