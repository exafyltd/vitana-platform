---
lane: meta-oauth
state: ready
next_actor: claude
depends_on: [gateway-profile-list]
updated: 2026-10-15T15:00Z
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

### 2026-10-15T14:40Z · kiro-202610151240-0371 · ready (revised)
Owner is creating the Meta app (checklist design.md §5); values arrive as GitHub repo secrets. Added D0 (prod GATEWAY_PUBLIC_URL + provisioning workflow). Q3 approved. next_actor: claude.

### 2026-10-15T15:00Z · kiro-202610151240-0371 · ready (on hold, owner)
Owner: hide E6/E7 until the Meta app is created; lane B2 does that. Resume this lane once the 4 GitHub secrets exist (design.md §5). next_actor: claude.
