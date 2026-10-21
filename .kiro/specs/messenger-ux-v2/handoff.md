---
slug: messenger-ux-v2
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: claude
state: parked
updated: 2026-10-21T12:31Z
parked_from: drafted
---
# Handoff — messenger-ux-v2 (Messenger: reliable sending, scroll, replies, media, search, sharing, push suppression)
Planner: Kiro seat `exafyltd` (session kiro-exafyltd-202610211130-c65e). Plan: `plan.md` (between the plan markers), sparred by CI PLAN-SPAR.
Detail: `tasks.md`; owner requirements R1-R13 and their mapping: `requirements.md`. 13 lanes, held at `ready` until
PLAN-SPAR allocates each lane's VTID. vitana-platform: `api-send-reliability` → `api-viewing-presence` →
`api-message-search` → `api-shared-content`. vitana-v1: `ui-send-status` → `ui-scroll-anchoring` → `ui-reply-jump` →
`ui-compact-grouping` → (`ui-media-album`, `ui-viewing-presence`) → `ui-message-search` → `ui-shared-cards`;
`ui-emoji-recents` independent. External preconditions: #1445 (R4/R5) and #1425 (R1 density), plan §8.
## Log
### 2026-10-21T12:00Z · kiro-exafyltd-202610211130-c65e · created → drafted
Owner spec "Vitanaland Messenger — UX Improvements & Functional Requirements" given to this session on 2026-10-21
(recorded in `requirements.md`). The owner gave no merge instruction for this plan; merges follow §7b.

### 2026-10-21T12:31Z · ci-plan-spar · drafted → parked
Not converged after 2 sparring sessions (evidence_floor_not_met). Parked with the open findings in sparring/.

### 2026-10-21T12:40Z · kiro-exafyltd-202610211130-c65e · parked (note, no state change)
Why the plan is parked. Session 1 ran 3 real rounds: R1 had 5 findings, R2 had 2 and R3 had 2. All were accepted and
the plan was changed for each. It escalated only at the round cap; the partner acknowledged every earlier answer.
The re-plan session 2 (`e0c47098…`) then failed before reviewing anything: `evidence_floor_not_met`, with 0 successful
`read_file` calls. That is the code-access failure described in the approved plan `sparring-floor-retry` (VTID-05240,
lane `floor-retry-code`, not built yet) and in open PR #4215 (`plan-spar-retry-invalid`). It is not a finding on this
plan. Today `evidence_floor_not_met` is not in `RETRYABLE_REASONS` (`scripts/collab/plan-spar.mjs:37`), so the plan
used up its 2 sessions.
Unblock: once the floor-retry fix is on `main`, the plan can get one more session. That needs PLAN-SPAR to treat
session 2 as an infra retry. The other way is an owner decision. No VTID exists and no code was written. The `_plan`
claim is released and the driver heartbeat removed.
