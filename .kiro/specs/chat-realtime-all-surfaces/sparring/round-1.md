# Sparring round 1 — in_progress

Session: `27620687-91f5-4472-9077-7904565c5ad7` · plan hash `6b64a56fdd847181bb1ddb4cae58715baf4fb92030a5f26a1a3c1963a530a8c1`

## Summary

The plan is well-structured and addresses a real user-facing problem across all chat surfaces. However, a critical verification gap exists: every vitana-v1 code premise (line numbers, file existence, behavior claims for 8+ files) is unverifiable because the pinned commit is for vitana-platform only, and vitana-v1 has no pinned ref in this session. I was able to verify the gateway-side claims (realtime relay, chat-messages-poller). The migration file cited in the plan is absent from vitana-platform's supabase/migrations. The governance rule citations (rules 31, 32, 48) partially misalign with the actual CLAUDE.md numbering.

## Findings

### R1-F1 [blocker]

Every vitana-v1 code premise is unverifiable. The plan makes 20+ specific line-number claims about 8 files in vitana-v1 (useGlobalMessages.ts, useTenantMessages.ts, useMessages.ts, GroupChat.tsx, useChatGroupsAsThreads.ts, useChatUnreadCount.ts, useTypingIndicators.ts, useMessageReactions.ts). The session pin is vitana-platform only — vitana-v1 has no pinned ref (read_file returns 'no pinned ref'). This exact issue was already flagged in the earlier group-chat plan sparring (R1-F2 in round-1.md). Without verification, the entire plan could be built on stale or wrong assumptions about file structure, channel names, subscribe callback shapes, or existing reconnect behavior — and every lane depends on these premises being correct.

- `exafyltd/vitana-platform:.kiro/specs/group-chat-realtime-status/sparring/round-1.md:21` — R1-F2 [major] Every vitana-v1 code premise is unverifiable in this review session (no pinned ref for exafyltd/vitana-v1). The plan makes specific line-number claims about GroupChat.tsx ... GitHub search for all of these identifiers in vitana-v1 returns zero hits. If the test template or staging spec doesn't exist, the test plan (Change 1) and staging proof (Change 4) fail

Suggestion: Pin the vitana-v1 commit in the sparring session so the reviewer can verify premises with read_file. The plan header says 'vitana-v1 origin/main fcc1e451b, read-only' — that ref should be the session's pinned commit for vitana-v1. Alternatively, the planner should include read_file transcripts or sha-pinned links for every cited line range, checked into the spec directory as verifiable evidence.

### R1-F2 [major]

The migration file 20260618110546_chat_messages_realtime_publication.sql is not in vitana-platform's supabase/migrations directory (verified via directory listing of 200+ files). The plan references it without specifying which repo. The earlier group-chat plan (plan.md line 37) says it exists in vitana-v1 on origin/main, but vitana-v1 is unverifiable in this session. If the migration is in vitana-v1 but Supabase migrations are managed from vitana-platform (which has the supabase/ directory at root), the migration may never have been applied. This is the plan's 'single largest unknown' (point 8) — but the ambiguity about which repo even contains the migration file makes the risk worse than stated.

- `exafyltd/vitana-platform:.kiro/specs/group-chat-realtime-status/plan.md:34` — 6. **Existence of the files this plan names.** On `origin/main` `7829ef2f2` these exist: ... `supabase/migrations/20260618110546_chat_messages_realtime_publication.sql`. 7. **Unverified premise: the realtime publication.** That migration adds `chat_messages` to the `supabase_realtime` publication. Whether it is applied to the database the app uses was not verified in this plan.

Suggestion: Clarify which repository contains the migration file and verify it exists at the cited path. If it's in vitana-v1, explain how vitana-v1 migrations reach the database (Supabase migrations directory is in vitana-platform at root). If the migration doesn't exist in either repo, the plan's dependency analysis must change: 'every lane depends on it' means every lane's realtime path is inert.

### R1-F3 [major]

PR number discrepancy with the earlier group-chat plan. The new plan references PR #1592 (head 50a001d85) on branch kiro/groupchat-realtime-status and says it will be 'closed as superseded'. But the earlier group-chat-realtime-status plan (plan.md) in the same repo references PR #1560 (head 90142e0c5) on the same branch name and also says it will be 'closed as superseded once the new PR is open'. The plan should clarify whether PR #1560 was already closed, whether #1592 is a second draft, and which commit (50a001d85 or 90142e0c5) the group-chat lane cherry-picks from.

- `exafyltd/vitana-platform:.kiro/specs/group-chat-realtime-status/plan.md:7` — The earlier draft implementation lives on the unmerged branch `kiro/groupchat-realtime-status` (commit `90142e0c5`, PR #1560, draft); its line numbers differ from main.
- `exafyltd/vitana-platform:.kiro/specs/group-chat-realtime-status/plan.md:76` — PR #1560 and its branch stay unchanged (no rewrite of pushed history). PR #1560 is closed as superseded once the new PR is open.

Suggestion: Clarify the PR lineage: state whether PR #1560 was already closed per the earlier plan's instruction; confirm whether PR #1592 is a new PR on the same or a different branch; specify which commit the group-chat lane cherry-picks from. If both PRs are still open, the plan should close the stale one as a prerequisite step.

### R1-F4 [minor]

The plan cites 'platform CLAUDE.md, rules 31, 32, 48' for staging test restrictions. In CLAUDE.md: ALWAYS rule 31 (line 154) is about the fixed sidebar ('The sidebar is fixed: exactly 10 items...'). The staging-writes rules are IF-THEN 31/31b/32 (lines 400-410), a different numbering namespace. 'Rule 48' does not appear anywhere in the 635-line CLAUDE.md. The earlier group-chat plan sparring (round-1 R1-F3) flagged this exact issue with 'rule 47'/'rule 48' labels not being grounded. Implementers following the plan may look for the wrong rule.

- `exafyltd/vitana-platform:CLAUDE.md:154` — 31. **The sidebar is fixed:** exactly 10 items in their fixed order, Start Stream in the sidebar utility zone. Start Stream is private AI + screen share — never Go Live / Live Rooms.
- `exafyltd/vitana-platform:.kiro/specs/group-chat-realtime-status/sparring/round-1.md:29` — R1-F3 [minor] The plan cites 'rule 47' (no suite, no merge) and 'rule 48' (staging tests read-only) multiple times as governance justification. The collaboration.md (the stated source of truth, 391 lines) uses section numbers §1–§9 and contains no numbered rules.

Suggestion: Replace 'rules 31, 32, 48' with the correct governance references. The staging-writes prohibition is IF-THEN 31/31b/32 in the Staging Verification Gate section of CLAUDE.md (lines 396-410). If 'rule 48' refers to a rule in .claude/rules/ or collaboration.md, cite it explicitly with file path and line.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
