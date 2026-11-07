# Sparring round 1 — in_progress

Session: `34722f39-a1b1-448f-a542-f5d00db4cf5c` · plan hash `b62afd38ddd42427360de3c27c0b462ae6db0bc5f3cf4519fcbffbb0973081d1`

## Summary

The plan is well-structured and thorough in its owner-gating, security posture (no credentials in repo), and scope limitation (no production profile). However, this review session only has vitana-platform pinned while **all five lanes target vitana-v1**, making 6 of the plan's 8 "Measured state" premises unverifiable against pinned code. The 3 vitana-platform premises I could verify all hold. I raise one major finding about the unverifiable premises and two minor issues.

## Findings

### R1-F1 [major]

Six foundational vitana-v1 premises cannot be verified because vitana-v1 is not pinned in this review session. These include: (1) eas.json has exactly two profiles `development` and `test-g1` with the stated fields at lines 7-18, no `submit` block, no credential field; (2) app.config.ts:34-37 throws for unset and `production` profiles; (3) NATIVE-CI.yml runs `node --test scripts/native/__tests__/*.test.mjs` at lines 263-264 on ubuntu-latest (this is critical for the eas-profile-guard auto-discovery claim); (4) no `ios/` or `android/` folder in apps/mobile/; (5) NATIVE-APP-PLAN.md gates at lines 100, 118, 195, 199, 204; (6) README.md gate table at lines 99-107. If any of these are stale or wrong, the plan's design decisions (especially Decisions 1, 6, 9 and the eas-profile-guard test plan) may be built on false premises. These must be verified before a VTID is issued.

- `exafyltd/vitana-platform:docs/programs/health-hub/STATUS.md:22` — | 7 | G3: store and signing ownership | Native app | waiting | — | owner: App Store Connect / Play Console access |
| 8 | Wave 0: Expo project, CI, parity ledger script, extraction dependency analysis | Native app | queued | — | macOS build minutes (EAS or GitHub) |

Suggestion: Pin vitana-v1 in the next review round so all six premises can be verified with read_file. Alternatively, the plan producer should cite exact commit SHAs for the vitana-v1 files and the reviewer session should include that pin.

### R1-F2 [minor]

The governance premise cites vitana-platform:scripts/collab/queue.mjs:86 for GOVERNANCE_PATHS and protected-gate-files.json, but every lane in this plan creates files in vitana-v1, not vitana-platform. The code at queue.mjs line 92 notes 'CI and vitana-v1 run single-file copies of queue.mjs', so vitana-v1 has its own copy of the governance logic. The plan assumes the two copies have identical GOVERNANCE_PATHS and protected-gate-files lists. If vitana-v1's copy diverges (e.g. different protected globs, different governance paths), the Kiro lane validation could behave differently than the plan predicts.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:83` — // VTID-05213: paths that only an `executor: claude` lane may change (governance: CI, rules, steering, automations,
// this script, the seat map). A Kiro lane that declares or touches one is refused by validate and scope-check —
// VTID-05276: unless the lane's reviewer is a reviewer agent and its permissions come from a trusted source.
export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**',
  'CLAUDE.md', 'docs/programs/areas.yaml'];

// VTID-05276 (plan §4.3), VTID-05408 (kiro-lane-admin §4): protected gate files — the gates themselves. A Kiro lane
// never changes one on a reviewer-agent accept alone; it needs the owner's instruction naming the plan plus a
// reviewer-agent accept on the current head (Claude Code is retired). The list lives in protected-gate-files.json next
// to this script; CI and vitana-v1 run single-file copies of queue.mjs, so the same list is compiled in for when the
// JSON is absent.

Suggestion: When vitana-v1 is pinned in the next round, verify that vitana-v1's queue.mjs copy has the same GOVERNANCE_PATHS array and either the same PROTECTED_GATE_BUILTIN or an equivalent protected-gate-files.json. Add a brief note in the plan citing vitana-v1's file.

### R1-F3 [minor]

The eas-profile-guard bans credential-like keys (including `serviceAccountKeyPath`) from eas.json (Decision 3, test plan). However, the plan's `eas-submit-workflow` lane will add a `submit` block to eas.json for Android Play Store uploads, which typically requires a Google Play service account key to authenticate. The plan does not explicitly state how the submit workflow provides this key to `eas submit` (CLI flag `--service-account-key-path`, environment variable, or EAS managed credentials). If the workflow implementation naively adds `serviceAccountKeyPath` to the submit block, the guard will fail it.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:238` — if (fm.executor === 'kiro') {
      for (const g of paths) {
        if (globTouchesProtected(g)) e.push(`paths "${g}" reaches a protected gate file ...`);
        else if (globTouchesGovernance(g) && !isReviewerAgent(fm.reviewer_seat)) e.push(`paths "${g}" reaches a governance path; ...`);
      }
    }

Suggestion: Add a note in the eas-submit-workflow lane scope or in Decision 3 specifying that the Google Play service account key is provided to `eas submit` via a GitHub Actions secret passed as the `--service-account-key-path` CLI argument (writing a temp file from the secret) or the `EXPO_SERVICE_ACCOUNT_KEY_PATH` environment variable, not via eas.json. This ensures the guard and the submit workflow are designed consistently from the start.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
