# Sparring round 1 — in_progress

Session: `17092071-449c-4b3b-a7d5-d3f3166a9b12` · plan hash `8744cd5b1e05ad6961b0adf83952b27c2318fd4655e815c0ba0f523d5004703d`

## Summary

The plan is well-structured, narrowly scoped (two new test files, no source changes), and internally consistent. However, the fundamental problem is that **every premise is in vitana-v1, which is not pinned in this review session**. The review session header pins only `exafyltd/vitana-platform@6dc6e1ba`, and all attempts to `read_file` or `list_dir` on vitana-v1 fail with "no pinned ref." All searches on vitana-v1 also returned zero hits. This means the sparring review cannot verify any of the 10+ specific claims about file contents, line numbers, ledger rows, resolver behavior, jest config, or test helpers. I raise this as a blocker because shipping a plan whose premises were never machine-checked defeats the purpose of adversarial sparring. Beyond that, I note one technical concern about the red-on-base strategy for a tests-only lane.

## Findings

### R1-F1 [blocker]

All plan premises about vitana-v1 are unverifiable in this review session. The plan makes specific claims about: (1) intents/mine.tsx being a Redirect at lines 7-11, (2) comm/my-groups/[id].tsx using useLocalSearchParams at lines 6-12, (3) ledger.json rows at lines 1601-1610 and 2464-2475, (4) NATIVE_ROUTES at resolve.ts:90 and NATIVE_PATTERNS at resolve.ts:154, (5) resolveWebPath behavior at resolve.ts:176-206, (6) jest.config.js roots configuration, (7) test helper availability at tests/community/mocks.ts and tests/helpers/no-network, (8) absence of any test mentioning intents/mine, (9) scripts/native/parity-ledger.mjs --check passing with 435 rows and 121 native routes. None of these can be confirmed because vitana-v1 is not pinned in this session. The sparring partner's mandate is to verify at least 3 premises with read_file — zero are verifiable here.

- `exafyltd/vitana-platform:.kiro/specs/native-wave3-release-r2/lanes/prereq-exit.md:11` — repos: [exafyltd/vitana-v1]
- `exafyltd/vitana-platform:.kiro/steering/vitana-pipeline.md:3` — Every owner task that results in a commit runs the Vitana pipeline end to end: plan(<slug>) PR → CI PLAN-SPAR → CI-allocated VTIDs → parallel lanes → reviewer agent

Suggestion: Re-run this sparring session with vitana-v1 pinned at the SHA the plan claims (e31bf4627ff3c705c20f8e6b718ce4dd03353b7f) so the sparring partner can verify premises. Alternatively, if the CI PLAN-SPAR workflow cannot pin two repos, the plan must include machine-generated evidence artifacts (e.g. file checksums, command output logs) committed to vitana-platform where they can be verified.

### R1-F2 [major]

The plan references 'root node scripts/native/parity-ledger.mjs --check' as a verification step but does not specify which repo contains the script. The prereq-exit lane doc (vitana-platform) references this same command in a lane scoped to repos: [exafyltd/vitana-v1], implying it lives in vitana-v1. The plan's verification section must be unambiguous about which working directory and repo the command runs in, since the builder may have both repos checked out.

- `exafyltd/vitana-platform:.kiro/specs/native-wave3-release-r2/lanes/prereq-exit.md:11` — repos: [exafyltd/vitana-v1] ... quotes the output of `node scripts/native/parity-ledger.mjs --check` on `origin/main`

Suggestion: Clarify that scripts/native/parity-ledger.mjs lives in vitana-v1 and that the verification command is run from the vitana-v1 root.

### R1-F3 [minor]

The red-on-base proof for a tests-only lane relies on uncommitted local mutations (change the redirect target, render a different screen) that are manually reversed before commit. This is fragile — if the reversal is incomplete, source changes outside lane scope ship. The plan says 'git diff on apps/mobile/app and apps/mobile/src must be empty' but this is a manual check, not a CI gate. CLAUDE.md states 'the protection is the mechanical checks (CI gates, STAGING-VERIFY)' — a manual diff instruction is not a mechanical check.

- `exafyltd/vitana-platform:CLAUDE.md:42` — That record is an audit trail; the protection is the mechanical checks (CI gates, STAGING-VERIFY).

Suggestion: Add to the verification step: run 'git diff --exit-code apps/mobile/app apps/mobile/src' as a scripted check and record its exit code in commands.log. Alternatively, do the red-proof in a git stash or separate worktree so the main checkout is never dirtied with out-of-scope mutations.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
