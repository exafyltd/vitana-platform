# Sparring responses — round 1

Every finding is answered below. F2–F6 are accepted and fixed in `plan.md` this round. F1 is accepted in
substance but its full resolution requires a governance-path change (`PLAN-SPAR.yml`) that the planner's
seat cannot make; it is recorded here and flagged for Claude Code, with the plan annotated so no native
`file:line` claim is presented as partner-verified until that change lands.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct and important. The sparring session is pinned only to vitana-platform (PLAN-SPAR.yml base checkout) while all native implementation code is in vitana-v1, so the partner cannot verify any native file:line claim. The real fix is a governance-path change the planner's seat (kiro/exafyltd) may not make: either add vitana-v1 as a pinned second checkout / extra_ref in vitana-platform:.github/workflows/PLAN-SPAR.yml so the partner can read apps/mobile/**, or relocate this spec to vitana-v1 (collaboration \u00a72, 'the repo where most code changes') and have the sparring call pass a vitana-v1 ref. Mitigation applied now: plan.md carries a Repo note stating every unqualified path is vitana-v1, that native file:line claims are planner-read from vitana-v1 origin/main and NOT partner-verifiable until the ref is added, and all citations are repo-qualified (R1-F2).",
    "deferred_to": "Claude Code governance lane: add vitana-v1 pinned ref to vitana-platform:.github/workflows/PLAN-SPAR.yml (or relocate spec + dual-ref). Tracked in plan.md Repo note."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Correct. docs/programs/native-app/NATIVE-APP-PLAN.md lives in vitana-v1, not vitana-platform, so the unqualified :95 citation 404s at the pinned platform commit. Fixed: all governance-doc citations are now repo-qualified (vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md:95 and :233; vitana-platform:.kiro/specs/health-native/handoff.md:52). The partner still cannot read the vitana-v1 file until R1-F1 is resolved; the Repo note states this."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Correct. tools/fixture-gateway/** and tests/fixture-gateway/** are at the vitana-v1 repo root (mirroring tools/orb-fake-gateway/), not under apps/mobile/**, so the blanket 'all paths under apps/mobile/**' self-check was false and Lane scope would break. Fixed: the plan's path-ownership section now lists every non-apps/mobile path explicitly \u2014 fixture-gateway (repo root), deep-link-push-smoke tests moved under apps/mobile/tests/g1-smoke/**, native-ci-workflow (.github, vitana-platform), real-g1-switch (docs/validation/g1/** repo root)."
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Correct. A single lane cannot span two repos (one branch:/pr: per lane), and eas.json belongs in vitana-v1:apps/mobile/eas.json while NATIVE-CI.yml is in vitana-platform:.github/workflows/. Fixed: build-profiles is split into eas-profiles (executor kiro, vitana-v1, apps/mobile/eas.json) and native-ci-workflow (executor claude, vitana-platform, .github/workflows/NATIVE-CI.yml), each with its own branch/PR/VTID. Dependency order preserved: env-profiles -> eas-profiles -> native-ci-workflow."
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Correct \u2014 this was a fabricated heading. No 'Why no host is exempt' section exists in vitana-platform:CLAUDE.md. Fixed: the citation now reads vitana-platform:CLAUDE.md rule 31 (VTID-03506), 'There is exactly one Supabase project and every frontend (incl. preview/staging) writes to it.' The safety reasoning was right; only the citation was wrong."
  },
  {
    "finding_id": "R1-F6",
    "disposition": "accepted",
    "rationale": "Fair. Added decision 8: MOBILE-DEVICE-E2E.yml runs the WEB frontend in an iOS Simulator via Safari/the accessibility tree \u2014 a different concern from bundling the native Expo JS \u2014 and NATIVE-CI.yml is workflow_dispatch-only (plus native-path push), so it adds no automatic macOS-runner cost and does not overlap that workflow's triggers."
  }
]
```

## Note for the next round
R1-F2 through R1-F6 are resolved in the plan block. R1-F1 is the one open item and it is **not** a plan
defect the planner can close alone — it needs Claude Code to give the sparring partner a vitana-v1 ref (or
relocate the spec with a dual ref). Until then this plan's native `file:line` claims are planner-verified
against vitana-v1 `origin/main`, not partner-verified. The plan is otherwise complete and the lane set is
now repo-consistent and Lane-scope-safe.
