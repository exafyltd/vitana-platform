# Health Hub + native app program — status

Shared status file for every session working on this program. Update it in the same PR as the work.

| Program | VTID | Plan | Sparring record |
|---|---|---|---|
| Health Hub | VTID-05020 | `docs/programs/health-hub/HEALTH-HUB-PLAN.md` | `docs/validation/VTID-05020/plan-sparring.md` |
| Native iOS + Android app | VTID-05021 | `exafyltd/vitana-v1` `docs/programs/native-app/NATIVE-APP-PLAN.md` | `exafyltd/vitana-v1` `docs/validation/VTID-05021/plan-sparring.md` |

Owner approval (Gate 1): 2026-10-10. Each work package below gets its own sparred plan and VTID before code.

## Work packages

| # | Package | Program | Status | VTID | Blocked on |
|---|---|---|---|---|---|
| 1 | Phase 0 / D12: remove wearable-derived condition labels from commerce, CI purpose boundary | Health Hub | next | — | — |
| 2 | Phase 0 / D1: token access and encryption, revoke on disconnect | Health Hub | queued | — | — |
| 3 | Phase 0 / D2: vendor-correct webhook verification, fail closed | Health Hub | queued | — | — |
| 4 | Phase 0 / D3–D5, D7, D8: fake cards, privacy switches, erasure gaps, false lab notice, partner-health confirmations | Health Hub | queued | — | — |
| 5 | G1 / 0T: test environment (Aurora test cluster + proxy, free-tier test Supabase project) | both | queued | — | AWS admin (cluster, ECS Exec/ssmmessages fix) |
| 6 | G2: Firebase push project health or replacement | Native app | queued | — | owner: Firebase/GCP project ownership |
| 7 | G3: store and signing ownership | Native app | waiting | — | owner: App Store Connect / Play Console access |
| 8 | Wave 0: Expo project, CI, parity ledger script, extraction dependency analysis | Native app | queued | — | macOS build minutes (EAS or GitHub) |
| 9 | `tr` fixup migration for `supported_locales` | both | queued | — | — |
| 10 | Fix stale "Active locales" paragraph in vitana-v1 CLAUDE.md (11 GA locales) | Native app | in this PR | VTID-05021 | — |
