---
slug: profile-vitana-cards
author: kiro
executor: kiro
next_actor: kiro
state: approved
vtids: [VTID-05210, VTID-05211, VTID-05212]
sparring_record: .kiro/specs/profile-vitana-cards/plan-sparring.md
updated: 2026-10-15T14:30Z
---
# Handoff — Vitana cards on the own profile, and card actions that work

The owner asked Kiro directly for this plan on 2026-10-15:
- on the profile, keep only the cards that enrich the profile;
- move them below the profile;
- make every Vitana card's action button work.

The owner then answered:
- keep E6/E7 (Instagram, Facebook) on the profile;
- placement as proposed.

**Next actor: Claude Code** (collaboration §7, "Kiro authors → Claude executes"):
1. Spar the plan.
2. Send Gate 1.
3. Allocate the VTIDs.
4. Assign the lanes (Kiro implements them if Claude sets `next_actor: kiro`).

Kiro has not allocated a VTID and has changed no code.

Lanes (all `ready`):
- `frontend-placement` (vitana-v1): profile = E1–E7, E11, G1; placed in the Posts tab (mobile) and below
  `ProfileLayout` (desktop), next to the Cover Library tile.
- `gateway-profile-list` (vitana-platform): the same list on the server; E6/E7 hidden while Meta OAuth is not
  configured (no dead cards).
- `card-actions` (vitana-v1): fixes G1 (does nothing on the profile), F4 (opens the assistant settings page instead
  of a conversation), E8/E9 (the hash is ignored), F8 (stuck busy), and E6/E7 in Appilix; plus a click test for every
  card.
- `meta-oauth` (vitana-platform; depends_on `gateway-profile-list`): **blocked on the owner**. It needs:
  - a Meta app;
  - secrets provisioned by Claude Code;
  - a migration off the Instagram Basic Display API, which Meta retired on 2024-12-04.

Open decisions: `design.md` §4, Q3 (only professional Instagram accounts can connect) and Q4 (does a Meta app exist?).

## Log
### 2026-10-15T13:20Z · kiro-202610151240-0371 · created → drafted
Analysis and plan drafted at the owner's request. next_actor: claude (spar → Gate 1 → VTIDs).

### 2026-10-15T14:10Z · kiro-202610151240-0371 · drafted (revised)
Owner answers applied: E6/E7 stay, placement as proposed. Added the action audit, the `card-actions` lane and the
`meta-oauth` lane. Read-only AWS check: no Instagram/Facebook credentials exist on any gateway. next_actor: claude.

### 2026-10-15T14:40Z · kiro-202610151240-0371 · drafted (revised)
Q3 answered (one sentence on E6: business/creator accounts only). Owner Meta-app checklist added (design.md §5). Read-only finding: prod gateway task def sets no GATEWAY_PUBLIC_URL/APP_URL, so OAuth callbacks fall back to https://vitana.app. next_actor: claude.

### 2026-10-15T15:00Z · kiro-202610151240-0371 · drafted (owner go-ahead)
Owner, 2026-10-15: "hide it until it is created, let us do the rest". So E6/E7 stay hidden (lane B, B2) until the Meta app exists, and lane meta-oauth is parked. Lanes frontend-placement, gateway-profile-list and card-actions go ahead. The owner wants them executed. This is not Gate 1 yet, because the plan has not been sparred.

Ask to Claude Code, now:
1. Spar the plan (one round).
2. Send Gate 1 with the findings.
3. Allocate 3 VTIDs.
4. Set next_actor: kiro on the three lanes.

Then Kiro implements.

### 2026-10-15T14:30Z · session_012cmH1XjbSwZqQxxAbKu321 · drafted → approved
Sparred (2 rounds, CONVERGED, plan hash `92964488a27e7401`) and approved by the owner at Gate 1. VTIDs: VTID-05210 `frontend-placement`, VTID-05211 `gateway-profile-list`, VTID-05212 `card-actions`. Lane `meta-oauth` stays parked (owner: hide E6/E7 until the Meta app exists; only B2 ships). The sparring partner's decisions are binding for the executor: G1 reads the cached `useEnrichmentCards('profile')` and falls back to `/me/profile#about`; the F4 ORB-first logic lives once in `TalkToVitanaCard`; C5 also appends `?return=mobile` to the social-connect fetch. Lanes are handed to Kiro in one PR each.
