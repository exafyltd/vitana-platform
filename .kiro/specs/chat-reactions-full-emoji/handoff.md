---
slug: chat-reactions-full-emoji
author: kiro
author_seat: jtadic
executor: kiro
next_actor: kiro
state: drafted
spar_refs:
  - exafyltd/vitana-v1: 8778404bd707d81125a30f77be5f58bb2345ff81
updated: 2026-11-19T14:30Z
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

### 2026-11-19T13:00Z · kiro-exafyltd-202611181004-a185 · drafted
Reviewed lane heads (reviewer agent accept): vitana-v1 478601eb06, vitana-platform 7b8729e0d7; both on refs/handoff/chat-reactions-full-emoji/reactions in their GitHub repos.
Publication as GitLab MRs is handed to Kiro 1 (seat hotmail, the session with GitLab access); this Kiro Web session cannot reach gitlab.vitanaland.com.
PLAN-SPAR waits for the preview-gateway-recovery confirmation. Under D2 a preview run gives a sparring verdict with allocation disabled; the official VTID comes only from the approved canonical allocation procedure after convergence.

### 2026-11-19T14:30Z · kiro-jtadic-202611191357-f5ff · drafted (attribution corrected)
`_plan` claim taken over by fast-forward from kiro-exafyltd-202611181004-a185 (same account, seat corrected to `jtadic`, Kiro 12, on
the owner's instruction). Lane `reactions` re-seated to `jtadic`. Pinned vitana-v1 head 8778404bd7. VTID: none; no allocation and no
`spec_status`/`status` change until the approved canonical procedure after convergence (an exception to sparring-first needs the
owner's explicit decision).
