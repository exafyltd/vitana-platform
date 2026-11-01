---
lane: fx-url
state: ready
next_actor: kiro
branch: kiro/wallet-fx-rate-url/fx-url
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-v1]
paths:
  - src/hooks/useEurUsdRate.ts
  - src/hooks/useEurUsdRate.test.ts
  - tests/e2e/staging/vtid-*-wallet-fx-rate.staging.spec.ts
  - docs/validation/VTID-*/**
updated: 2026-11-01T13:56Z
---
# Lane: fx-url (repo vitana-v1)
Repo: **exafyltd/vitana-v1** (paths are relative to that repo). Tasks T1–T5 in `tasks.md`.
**Held until PLAN-SPAR allocates this lane's VTID.** Branch `kiro/wallet-fx-rate-url/fx-url`; trailers
`Collab-Session` / `Collab-Lane: wallet-fx-rate-url/fx-url`. §7a applies: no VTID by hand, no production workflow,
no live writes, no wallet route added. `docs/validation/VTID-*/**` means this lane's own VTID directory only.
## Log
### 2026-11-01T13:56Z · kiro-exafyltd-202611011353-f644 · ready
Lane created with the plan.
