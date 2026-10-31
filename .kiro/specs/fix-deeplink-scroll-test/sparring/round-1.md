# Sparring round 1 — in_progress

Session: `77a3c32b-7fc4-4d82-bb6c-6192597ae3db` · plan hash `40563798eadd3a23385528a215ab36b990dd179eb046b8ba1fe251de7a0db701`

## Summary

The plan is well-structured and conservative: it proposes a single test-only change in vitana-v1 to fix a date-time-bomb in outbox fixtures, after correctly diagnosing that the owner's named deep-link test was already fixed by VTID-05313. The governance analysis (single lane, no hot files, no protected gate files, staging-tests.json for test-only changes) is coherent with common-rules.md.

The principal limitation of this review is that vitana-v1 is not pinned in this session, so the core premises about the test file line numbers, outbox.ts constants, and the UNIT-TESTS workflow cannot be directly verified with read_file. All three vitana-v1 searches also returned zero hits, which is unusual. The plan's claims are internally consistent and plausible, but I flag the unverifiable premises explicitly below. One minor governance observation is noted.

## Findings

### R1-F1 [major]

All core premises about vitana-v1 source code (outbox.ts OUTBOX_MAX_AGE_MS at line 48, prune at line 90; the test file's fixed timestamps at lines 204/205/261; the deeplink test's partial mock at lines 38-44; UNIT-TESTS.yml workflow structure; AWS-STAGE-DEPLOY-FRONTEND.yml trigger paths) are unverifiable in this review session because vitana-v1 has no pinned ref and all searches against it returned zero results. If any of these premises are wrong (e.g., OUTBOX_MAX_AGE_MS is not 7 days, or the prune logic works differently, or the fixed timestamps are at different lines), the planned fix would be incorrect.

- `exafyltd/vitana-platform:.kiro/pipeline/common-rules.md:1` — 1. **Repos.** `<vitana-platform>` = the checkout of `exafyltd/vitana-platform` ... `<vitana-v1>` = the checkout of `exafyltd/vitana-v1`.

Suggestion: The planner should provide explicit evidence in the plan (or as an attachment) that the vitana-v1 premises were verified: e.g., the exact output of `grep -n 'OUTBOX_MAX_AGE' src/lib/messaging/outbox.ts`, the relevant test file lines, and the workflow file excerpts. Alternatively, if PLAN-SPAR can be configured to pin vitana-v1 for the review, that would enable direct verification.

### R1-F2 [minor]

The plan says 'at most 4 files' in the lane but common-rules §11 defines a small task as '1 lane, at most 3 files'. The lane touches 1 source file + 3 docs/validation files = 4 files. While the validation artifacts (red-on-base.txt, commands.log, staging-tests.json) are standard governance artifacts every lane produces and arguably don't count toward the §11 limit, the plan should clarify this to avoid a Lane scope or review dispute.

- `exafyltd/vitana-platform:.kiro/pipeline/common-rules.md:65` — at most 6 build lanes per plan; ... a small task (1 lane, at most 3 files) is one lane, no fan-out; interfaces between lanes are defined in the plan, not by the agents.

Suggestion: Clarify that the '3 files' threshold in §11 refers to changed source/config files (not validation evidence artifacts), or explicitly note that this task has 1 code file changed and 3 evidence files which are standard lane outputs.

### R1-F3 [minor]

The plan proposes `const T0 = Date.now() - 60_000` to make outbox fixture timestamps relative. While 60 seconds is well within the claimed 7-day OUTBOX_MAX_AGE_MS, the plan does not specify a minimum margin or document why 60 seconds was chosen. If the outbox also has a minimum-age check or if another part of the test logic is sensitive to the exact offset between T0 and 'now', the chosen offset could matter. The plan should note the constraint more explicitly.

- `exafyltd/vitana-platform:.kiro/pipeline/common-rules.md:42` — skip, disable or loosen a test; accept your own lane. Staging tests are read-only.

Suggestion: Add a brief note that the 60-second offset is chosen to be (a) well within the 7-day max age, (b) old enough that the pending→failed ordering is deterministic, and (c) not so old that any other age-sensitive logic could trigger. If the outbox has any other time thresholds besides OUTBOX_MAX_AGE_MS, list them.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
