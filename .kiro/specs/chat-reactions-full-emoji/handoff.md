---
slug: chat-reactions-full-emoji
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
spar_refs:
  - exafyltd/vitana-v1: 173161fb64fbbb75b531872320e316ca6307df8e
updated: 2026-11-18T10:30Z
---
# Handoff — chat-reactions-full-emoji

Full emoji reactions in chat on mobile, web and the ORB voice tool: the shared 181-emoji set, six shortcuts, at most
six distinct emojis per member per message (database cap), existing reactions kept, legacy heart forms one reaction.

The work already exists as vitana-v1 PR #1697 and vitana-platform PR #5105 (branch `claude/intelligent-pascal-3ynr7i`,
started by a Claude Code session; the owner approved Gate 1 on 2026-11-18). Their commits lack the Collab trailers, so the
replacements replay the same commits from current main. This plan puts it on the Kiro pipeline so
CI PLAN-SPAR spars it and allocates its VTID. One lane, `reactions`, covers both PRs; both carry the same VTID.

`spar_refs` pins the replacement vitana-v1 head (`9753b758c`, on current main `78455457b`), so the partner can verify the v1 premises.

Lanes: `reactions` (`lanes/reactions.md`).

## Log
### 2026-11-18T10:30Z · kiro-exafyltd-202611181004-a185 · drafted
Plan written from the two open PRs, with the legacy-heart toggle fix and the isolated cross-client check added.
