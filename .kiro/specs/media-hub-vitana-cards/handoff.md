---
slug: media-hub-vitana-cards
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-03T10:45Z
vtids: []
---
# Handoff — media-hub-vitana-cards
The owner asked to remove the Vitana cards from the Media Hub screen. The phone screenshot shows the "People who match
you / See matches" card; it is the first card of the `community` card strip that `MediaHub.tsx` mounts at line 875.
This plan removes that mount and its import, adds a read-only staging spec that proves the cards are gone, and records
the evidence. One lane, in vitana-v1.
Plan: `plan.md`. Tasks: `tasks.md`.
Lanes:
- `media-hub-cards`: repo `exafyltd/vitana-v1`, executor **kiro**, seat **exafyltd** (frontend area, `docs/programs/areas.yaml`).
  Its paths are not protected gate files (`scripts/collab/protected-gate-files.json`).
## Log
### 2026-11-03T10:45Z · kiro-exafyltd-202611031037-633b · drafted
Written from the owner's request and a read-only investigation of vitana-v1 `origin/main` `6b9137ac5`
(`MediaHub.tsx:2` import, `:874-875` mount; `MediaHubSpotlight.tsx` does not render the strip).
Next: PLAN-SPAR spars this PR.
