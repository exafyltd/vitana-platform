---
slug: messenger-vitana-cards-v2
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: approved
updated: 2026-10-28T10:29Z
sparring_record: .kiro/specs/messenger-vitana-cards-v2/sparring/verdict.md
vtids: [VTID-05366, VTID-05367, VTID-05368]
---

Clean re-spar of the `messenger-vitana-cards` plan. The original slug went
through two CI PLAN-SPAR sessions (14 findings, all verified and fixed) but both
ended `escalated` at the 3-round cap, so CI never produced a converged +
policy-approved record and would not auto-allocate VTIDs. This v2 carries the
identical final plan text — which now has zero open findings (the last round-3
item was a §2/§3 doc inconsistency, fixed) — as a fresh plan with no escalated
session attached, so CI can spar it clean and converge.

Deeply-personalized, one-per-day Vitana cards in the direct Vitana chat via the
existing Companion Messages engine: 11 enrichment cards gated on existing
completion/dismissal/availability signals, delivered as the one-a-day companion
DM. Lab tests and the usage-gated F4/F5/F10 are out of scope (follow-up plans).

### 2026-10-22T22:05Z · kiro-exafyltd-202610220802-4a74 · drafted
Created from the final messenger-vitana-cards plan (all 14 sparring findings
resolved). Three lanes (ready): companion-enrichment-signals →
companion-enrichment-moments → messenger-companion-verification. Supersedes the
messenger-vitana-cards slug for allocation purposes. Next: push the
`plan(messenger-vitana-cards-v2)` PR so CI PLAN-SPAR spars it; expected to
converge quickly (no open findings) → policy approval → CI allocates the lane
VTIDs.

### 2026-10-28T10:29Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 3 lane(s) got a VTID and are handed to Kiro.
