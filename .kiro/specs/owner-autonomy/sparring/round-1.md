# Sparring round 1 — in_progress

Session: `be8c7d1d-64e0-459b-9243-35d84a5a1d52` · plan hash `b20d3d4cfed901262d9e414a58e61857ac3d23b1d8869c375dea7e7e7df61f4c`

## Summary

The plan is thorough and well-structured. I verified 12 distinct premises against the platform codebase; all hold. The core mechanism (a new `inclusion: always` steering file in `.kiro/steering/` that is automatically picked up by both Kiro IDE and the `kiro-web-steering.mjs` generator) is sound. The guard extension to prevent future weakening is well-designed. The lane structure correctly uses `executor: kiro` with the reviewer agent, and the changed paths are governance paths (`.kiro/steering/**`, `.claude/**`) but not protected gate files, so a reviewer-agent accept is sufficient. The vitana-v1 repo is not pinned in this session, so I cannot verify v1-specific claims, but the platform-side premises all check out. I have two minor findings.

## Findings

### R1-F1 [minor]

Change E updates the Configuration Sync template (docs/kiro/cloud-config/vitana-kiro-web-bootstrap.md) but the plan does not explicitly state that the owner must re-upload it to Kiro's Configuration Sync (Agent Config → Cloud Config). The current bootstrap doc (kiro-web-bootstrap.md lines 41-43) describes this as a 'One-time owner step'. After the merge, the updated template in the repo is inert until re-uploaded. Since the primary delivery mechanism (the repos' .kiro/steering/ via kiro-web-steering.mjs) works without re-upload, this is not blocking, but the verification section (§5) should list the re-upload as a post-merge action or acknowledge it is deferred.

- `exafyltd/vitana-platform:docs/kiro/kiro-web-bootstrap.md:40` — 1. **One-time owner step (persists across sandboxes):** in Kiro, *Agent Config → Cloud Config*, upload
   [`cloud-config/vitana-kiro-web-bootstrap.md`](cloud-config/vitana-kiro-web-bootstrap.md) as a user-level steering
   file. Every later Kiro Web session of that account runs the generator first. Kiro cannot do this upload itself.
- `exafyltd/vitana-platform:docs/kiro/cloud-config/vitana-kiro-web-bootstrap.md:1` — ---
inclusion: always
---
# Vitana on Kiro Web: load the repositories' rules first (user-level steering, plan kiro-web-steering)

Upload this file once as a user-level steering file through Kiro Configuration Sync.

Suggestion: Add a step in §5 (Verification after merge): 'Re-upload docs/kiro/cloud-config/vitana-kiro-web-bootstrap.md to Configuration Sync so the short-form instruction applies before repos are cloned.' Or note explicitly that the repo steering is the primary mechanism and the Configuration Sync update is deferred / opportunistic.

### R1-F2 [minor]

The plan's stop table in §3.A lists 'VTID allocator down (§4.1)' as a stop anchor, and the guard in §3.D checks for the text anchors including 'STAGING-VERIFY' and '§7d' etc. However, the guard anchor list does not include a check for '§4.1' or 'VTID allocator' even though it is listed as a stop row. If the plan intends the guard to prevent removal of any stop row, the VTID-allocator-down stop could be silently removed from the file without the guard catching it. The guard checks §7d, §7c, §3a, AGENTS.md, five-part, STAGING-VERIFY and the 'never end a reply' rule — 7 anchors for ~12 stop rows.

- `exafyltd/vitana-platform:CLAUDE.md:341` — 1. **IF** a task has no VTID → **THEN** get one per ALWAYS 2b / §4.1 once its plan is sparred and approved (a Kiro plan's come from CI PLAN-SPAR) and continue. **STOP only when allocation fails** (allocator disabled, DB error) — never for the mere absence of one, and never as a prompt to ask the user for one.
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:50` — function check(root) {
  const errors = [];
  ... // current check() has no owner-autonomy anchor validation

Suggestion: Either add anchors for the remaining stop rows (VTID allocator, Commerce friction, design-contract change, live-write verification) to the guard's checked set, or document in the plan that the 7 chosen anchors are a representative sample and not a 1:1 mapping. The former is safer; the latter is acceptable if the plan's §7 risk note about text checks is considered sufficient.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
