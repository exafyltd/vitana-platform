# Sparring round 1 — in_progress

Session: `d65f076b-d364-4920-9f60-9f0a1756cd30` · plan hash `1c03e3e28836fc961b8d659a4bb79dab4adec5f7bb1f177c9f7481de11d392c4`

## Summary

The plan addresses a real user-facing latency problem in group chat and is thoughtfully scoped. However, several premises cannot be verified because vitana-v1 has no pinned ref in this review session, and all core code claims are in that repo. I found one governance conflict regarding commit trailers on the pre-existing commit, and a minor citation issue with rule references. I dropped the finding about .kiro/specs messenger specs since I cannot cite a read_file result for it.

## Findings

### R1-F1 [major]

The plan keeps commit 90142e0c5 (from the lane branch) without Collab-Session / Collab-Lane trailers, asserting that §3 of collaboration.md allows identification by PR title alone. But §3 actually states: 'Every commit of lane work carries the trailers Collab-Session: <id> and Collab-Lane: <slug>/<lane-id>'. The Collab handoff CI check (§9) validates trailers. A commit without trailers may keep the Collab handoff check red even after the new commit with trailers is added, since §3's requirement is per-commit, not per-PR.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:86` — - Every commit of lane work carries the trailers
  `Collab-Session: <id>` and `Collab-Lane: <slug>/<lane-id>` (`<slug>/_plan` for coordinator commits).
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:384` — PR-GATE **Collab handoff** (`queue.mjs validate`, and the `scripts/collab/*.test.mjs` suites once it runs as its own job) checks every changed `handoff.md` / lane file, every state change, and the session/lane trailers

Suggestion: Either (a) amend commit 90142e0c5 to add the required trailers (this is an amendment of the lane's own commit, not a rebase of foreign history), or (b) squash the lane branch into a single new commit with trailers. If the Collab handoff check only inspects the HEAD commit or the PR-level metadata rather than every commit, cite the specific check logic as evidence that the trailer-less commit is tolerated.

### R1-F2 [major]

Every vitana-v1 code premise is unverifiable in this review session (no pinned ref for exafyltd/vitana-v1). The plan makes specific line-number claims about GroupChat.tsx (lines 67, 288-299, 302, 317), useGlobalMessages.ts (lines 2054-2060), and useChatGroupsAsThreads.ts (line 26), plus cites the existence of GroupChat.vtid-04921.test.tsx (as the test template), the staging spec vtid-04921-group-chat-latest.staging.spec.ts, and the migration 20260618110546_chat_messages_realtime_publication.sql. GitHub search for all of these identifiers in vitana-v1 returns zero hits. If the test template or staging spec doesn't exist, the test plan (Change 1) and staging proof (Change 4) fail; if the migration doesn't exist, the 'Unverified premise' in point 6 is moot because there is nothing to verify.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:22` — `.kiro/specs/<slug>/` in the repo where most code changes (plans that span both repos: `vitana-platform`):

Suggestion: The planner should provide verifiable evidence for each vitana-v1 premise: (a) confirm the test template file GroupChat.vtid-04921.test.tsx exists on the default branch (include its path), (b) confirm the staging spec vtid-04921-group-chat-latest.staging.spec.ts exists, (c) confirm the migration file exists (or adjust the plan if it doesn't). Ideally the plan PR should include a read-file transcript or sha-pinned link for each cited file.

### R1-F3 [minor]

The plan cites 'rule 47' (no suite, no merge) and 'rule 48' (staging tests read-only) multiple times as governance justification. The collaboration.md (the stated source of truth, 391 lines) uses section numbers §1–§9 and contains no numbered rules. Line 230-231 does say 'staging tests read-only' and various staging-test requirements exist, but the plan's 'rule 47'/'rule 48' labels are not grounded in any governance document visible at the pinned commit.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:230` — - Every existing rule is unchanged: sparring before a VTID, the `vtid_ledger` gate, never test against production,
  staging tests read-only, production only by PUBLISH.

Suggestion: Replace 'rule 47' / 'rule 48' with the actual governance section or file reference (e.g., 'collaboration.md §7a line 230' or the specific pipeline doc). If these are rules from a vitana-v1-local governance file or the pipeline common-rules.md, cite it explicitly.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
