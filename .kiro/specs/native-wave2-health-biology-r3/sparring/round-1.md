# Sparring round 1 — in_progress

Session: `db6a4fa2-da31-4410-ab0f-2419759db9f4` · plan hash `33b1552c1a19351e5e9cbee5c1b8994a581a073f25fb29633e95997ecafa701b`

## Summary

Thorough verification of the plan's key premises. The core factual claims hold up well: vitanaIndex.ts is genuinely IO-free with the exact exports claimed, the 24-row health-lane partition (4+4+16) is exact, assertNotProduction guards the native app, Plans.tsx write mutations are correctly identified, PillarsOfHealth.tsx renders VitanaIndexValue in the non-Spotlight branch, and the App.tsx routes match. One premise — the N5a health-sync module already being on main — could not be verified at the pinned commit, which affects the contract-test design described in the plan.

## Findings

### R1-F1 [major]

The plan asserts 'the n5a-health-sync module code is already merged to vitana-v1 main (#1398 → 8fea5e652, 2026-10-14)' and that the contract test 'imports both the stub and — through the real module path — the N5a export and asserts structural compatibility'. However, at the pinned commit (a994fcf) the native app's src directory contains auth, config, i18n, identity, linking, navigation, orb, ports, push, screens, shell, theme, types, ui — but no health-sync directory. The ports directory (visible in the env.ts import at line 21: `import type { CoreEndpoints } from '../ports/core'`) contains no health-sync port either. If the N5a export does not exist at any importable path, the contract test that claims to import 'the real export through its module path' cannot compile as described. The plan must either confirm the exact file path of the N5a export at the pinned commit, or acknowledge the export is not yet on main and adjust the contract-test description to stub-only mode until N5a lands.

- `exafyltd/vitana-v1:apps/mobile/src/config/env.ts:20` — // VTID-05186: through the core port (tests/ports.test.ts — app code reaches lane packages only via src/ports).
import type { CoreEndpoints } from '../ports/core';

export type ConfigKey = 'gatewayUrl' | 'supabaseUrl' | 'dataApiUrl' | 'authRedirectUrl' | 'webBaseUrl';
- `exafyltd/vitana-v1:apps/mobile/src/config/env.ts:1` — The complete native app configuration file shows the port-based module structure. No health-sync module, port, or import is referenced anywhere in this file or the surrounding config infrastructure.

Suggestion: Identify the exact file path of the N5a export on main at the pinned commit. If it does not exist, rewrite the contract-test paragraph to describe stub-only mode with a clear 'the real-import assertion activates when N5a lands' conditional, rather than stating the module 'is already merged'. This avoids the implementer trying to import a non-existent path.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
