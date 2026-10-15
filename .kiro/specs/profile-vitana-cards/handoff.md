---
slug: profile-vitana-cards
author: kiro
executor: claude
next_actor: claude
state: drafted
updated: 2026-10-15T13:20Z
---
# Handoff — Vitana cards on the own profile

The owner asked Kiro directly for this plan on 2026-10-15. On the profile, keep only the cards that enrich the
profile, and move them below the profile itself.

**Next actor: Claude Code.** This follows collaboration §7, "Kiro authors → Claude executes":
1. Claude Code spars the plan (skill `plan-sparring`).
2. Claude Code sends Gate 1 to the owner.
3. On "yes", Claude Code allocates the VTIDs and assigns the lanes. Kiro can implement them if Claude Code sets
   `next_actor: kiro`.

Kiro has not allocated a VTID and has changed no code.

Summary:
- **R1:** the profile shows only E1–E5, E11 and G1. It drops E6–E10 and F2 Vitana Index, F4 Talk to Vitana and
  F7 Invite.
- **R2:** the cards move from above the ID card to the enrich-your-profile zone next to the Cover Library tile:
  - mobile: the Posts tab, the default tab;
  - desktop: below `ProfileLayout`.

Lanes (both `ready`, independent):
- `frontend-placement` (vitana-v1)
- `gateway-profile-list` (vitana-platform)

Sparring questions: `design.md` §4.

## Log
### 2026-10-15T13:20Z · kiro-202610151240-0371 · created → drafted
Analysis and plan drafted at the owner's request. next_actor: claude (spar → Gate 1 → VTIDs).
