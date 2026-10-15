---
lane: meta-oauth
state: ready
next_actor: claude
depends_on: [gateway-profile-list]
updated: 2026-10-15T14:10Z
---
# Instagram and Facebook connect working (vitana-platform)

Tasks: lane `meta-oauth` in `tasks.md`. Design: `design.md` §3 (E6/E7).

Blocked on two things:
- the owner's Meta app (decisions Q3 and Q4);
- Claude Code provisioning the 4 secrets.

Kiro has no access to either and makes no AWS writes.

## Log
### 2026-10-15T14:10Z · kiro-202610151240-0371 · created → ready
Drafted. A read-only check on 2026-10-15 found no INSTAGRAM_/FACEBOOK_ env or secret on any gateway task definition,
and the Instagram provider still uses the Basic Display API, which Meta retired on 2024-12-04. next_actor: claude.
