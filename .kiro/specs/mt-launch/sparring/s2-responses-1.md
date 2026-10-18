# Responses — session 3857a677, round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified at services/gateway/src/routes/admin-signups.ts:205 — `const tenantId = process.env.DEFAULT_TENANT_ID;` and all three dispatchEvent calls (user.signup.completed :210, user.signup.referral :217, user.signup.shared_link :225) use that hardcoded default, not the signing-up user's actual tenant. The plan's claim that referral/invite attribution was 'already tenant-scoped' is false. Fixed: Problem #5 now states the DEFAULT_TENANT_ID bug explicitly; the support-landing lane now OWNS per-tenant referral attribution (resolve the real tenant from the referral code's owning tenant / invite record and dispatch against it), dark behind mt.launch_support, with a non-default-tenant Jest test; added a matching Risk. The founding_invites_30 intake item stays (the send is ops) but the attribution mechanism is now in-scope and fixed.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: live-tool-catalog.ts exists only at services/gateway/src/orb/live/tools/live-tool-catalog.ts and is the ORB-live voice persona-switch tool (Devon handoff prose at :945-969), NOT a feedback-ticket router. The real ticket data-plane + specialist detection is services/gateway/src/routes/feedback-intake.ts (header :5-19 lists handoff-detect/start/turn/complete; KIND_BY_AGENT devon/sage/atlas/mira at :32-37). The plan's change sites (feedback-intake.ts, feedback-admin.ts) were correct; only the Problem #4 citation was wrong. Fixed: Problem #4 now cites feedback-intake.ts:32-37 as the specialist-detection site and explicitly notes live-tool-catalog.ts is a separate ORB-live concern. Lane scope unchanged (still correct).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: isHealthTable() exists nowhere in the gateway at the pinned commit (git grep -l over services/gateway = 0), and vtid-05025-commerce-health-boundary.test.ts defines HEALTH_TABLES inline (7 occurrences, including the regex at :248). The plan did contradict itself (Tests implied inline regex; Depends-on said 'references the canonical list and does not keep its own'). Resolved to Option A, unblocked: the D18 test ships its own INLINE HEALTH_TABLES regex now (matching the vtid-05025 pattern), with no import of isHealthTable(); when mt-identity ships that predicate (O1) the inline list is replaced by importing it, tracked as a follow-up on mt-identity rather than a compile-time blocker. Fixed both the Tests section and the Depends-on section so they agree and neither tenant-owner-analytics nor worker-test-gate is blocked on an unshipped spec.",
    "deferred_to": "mt-identity (isHealthTable import migration — follow-up, non-blocking)"
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "support-landing imports tenant-feature-flag.ts, created by pack-intake-admin (same spec, same repo/seat). The plan already declared depends_on: pack-intake-admin, but lacked an explicit compile-order guard. Fixed: the support-landing Fix bullet now states its VTID is gated to merge AFTER pack-intake-admin's VTID is closed, so the imported file is guaranteed present before support-landing compiles. The lanes are NOT merged (CROSS-SPEC lane rule / §4.7 keep DB and code lanes separate and avoid over-merging); depends_on + VTID sequencing is the mechanism.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Verified: community-invites.ts:79 is only the OASIS event payload (referral_id, referred_id, rewarded, reward_reason) inside the /claim emit block (:73-80); the attribution itself runs in claimInvite(sb, user_id, code, ...) at :65 with no tenant parameter. The line does not demonstrate tenant-scoped attribution. Fixed: Problem #5 removed community-invites.ts:79 as attribution evidence and now describes the /claim path (:54-82) as tenant-agnostic, reinforcing R1-F1 instead of obscuring it.",
    "deferred_to": ""
  }
]
```
