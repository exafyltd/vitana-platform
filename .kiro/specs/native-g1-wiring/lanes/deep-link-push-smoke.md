---
lane: deep-link-push-smoke
state: ready
next_actor: kiro
depends_on: [vitana-v1-verified, env-profiles, fixture-gateway]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/tests/g1-smoke/**
  - apps/mobile/src/push/g1-test-provider.ts
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-10-20T08:41Z
vtid: VTID-05248
---
# Deep-link + push smoke against the fixture gateway (decision 4)
Plan: `.kiro/specs/native-g1-wiring/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: deep-link-push-smoke -->` (tasks D1–D6) are authoritative. VTID: assigned by CI after
PLAN-SPAR converges; do not start before `vtid:` is set here.
**Goal.** Prove the Wave 1 exit path offline (program §5 Wave 1 exit, `NATIVE-APP-PLAN.md:214`): a
signed-in member (fixture `auth/me`) gets a remote config with `push_enabled` on; a `G1TestPushProvider`
(`src/push/g1-test-provider.ts`, installed via `setPushProvider`, `provider.ts:52`; FCM waits for G2)
posts its token to the fixture and a push `data.url` resolves through `resolveLink`
(`src/linking/resolve-link.ts`) to the right route; every `LINK_PATHS` universal link
(`app.config.ts`: `/auth/confirmed`, `/reset-password`, `/oauth/complete`, `/i/:code`) resolves through
`resolveLink` / `link-router` / `auth-port`. Point the smoke's config `gatewayUrl` at the fixture on
`127.0.0.1` (loopback is not a blocked host).
**Acceptance (the reviewer seat checks these):**
- The three smoke suites (remote-config, push, deep-link) pass; `updateRequired` asserted from a high
  `min_supported_version`; `NoopPushProvider` is the default and `G1TestPushProvider` is only set inside
  tests (guard test).
- No Firebase package added; no real host reached (fixture only).
- `cd apps/mobile && npm test`, `npm run typecheck` green; NATIVE-CI and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only shell nav), `plan-sparring.md`.
  PR states this proves navigate + push + deep link against the **fixture**; real-G1 is gated on
  `real-g1-switch`.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no
writes to Supabase/AWS, no test against production; staging specs read-only.
## Log
### 2026-10-17T10:56Z · <kiro-session-id> · created → ready
Lane drafted with the plan. Depends on `env-profiles` (test-g1-shaped config) and `fixture-gateway` (the
server it points at). Next: PLAN-SPAR spars the plan; once a VTID is written here and the two deps are
done, seat `exafyltd` claims the lane (`queue.mjs claim native-g1-wiring/deep-link-push-smoke --session <id>`).

### 2026-10-20T08:41Z · ci-plan-spar · ready (VTID allocated)
VTID-05248 allocated after policy approval (converged-auto-v1).
