# Sparring round 2 — converged

Session: `b9a2c552-d8d5-47fb-871e-7c7735d16c07` · plan hash `813e8850fd353a66e69b9eadf7c3a63923aebcadd71740380490aa901f16266c`

## Summary

Round 2 review of the revised multi-tenant "rest" plan. Both prior findings (R1-F1 cors closure-scoping, R1-F2 unpinnable v1 premises) have been substantively addressed: the cors lane now pins an env-driven `CORS_EXTRA_ORIGINS` mechanism that appends to module-scope `ALLOWED_ORIGINS` without widening the regex patterns or the narrow MCP/.well-known rules, and the two highest-risk v1 premises now carry platform citations plus a build-time re-check. I verified the cors structure, the env-list precedent in outbound-http-worker.ts, the admin-autopilot "reads neither header" claim, the admin-tenants endpoint, and the command-hub ownership guard. Remaining issues are minor: a self-contradictory "not a governance path" statement, the test-isolation detail for env-driven CORS, and an unverified load-bearing v1 premise (the `--brand-*` runtime setters) that is not covered by the committed build-time re-check.

## Findings

### R2-F1 [minor]

The cors-config lane says 'Not a governance path (`services/gateway/src/**`)' immediately after describing a hot-file constraint. The file it edits (services/gateway/src/middleware/cors.ts) IS under `services/gateway/src/**`, so the parenthetical directly contradicts the assertion it is attached to, and the seat-assignment rationale ('uncovered-platform gateway rule') is not one I can verify from a non-existent guard. The sentence is ambiguous enough that the executor could misread whether some ownership/seat guard applies to this lane.

- `exafyltd/vitana-platform:services/gateway/src/middleware/cors.ts:7` — const ALLOWED_ORIGINS = [ ... ]

Suggestion: Clarify the sentence: name the specific guard/rule (if any) that does NOT block this path, or drop the parenthetical. State plainly that the only constraint on cors.ts is the ~20-line, single-PR hot-file rule and the covered-gateway seat rule, with a pointer to whichever guard script enforces that seat rule.

### R2-F2 [minor]

The theme-tokens lane's entire value rests on a vitana-v1 premise that `useTenant.tsx:122-133` sets `--brand-accent/-bg/-fg` on documentElement at runtime, and that the golden test asserts nothing currently consumes them. The `var(--brand-accent, <maxina hsl>)` fallback mapping only produces a tenant-distinct render if those custom properties are actually set. This premise is load-bearing but was NOT included in the committed build-time re-check (which the planner scoped to the two security premises: admin-api.ts header injection and the gateway header readers). If the v1 setters differ, the theme-tokens lane silently ships as a no-op while its test still passes Maxina's compiled fallback.

- `exafyltd/vitana-platform:services/gateway/src/middleware/cors.ts:67` — allowedHeaders: ["Authorization", "Content-Type", "apikey", "X-Vitana-Active-Role", "X-Vitana-Tenant", "X-Vitana-User", "X-User-ID"]

Suggestion: Add `useTenant.tsx` `--brand-*` setters (and the gen-tokens.mjs `:root`/`.dark`-only claim) to the executor's build-time premise re-check, stopping the lane with next_actor: claude if they do not match, in the same way AF1 is checked. At minimum state that the theme-tokens lane is re-verified against the actual v1 file before the golden is modified.

### R2-F3 [minor]

The cors-config tests depend on `jest.isolateModules` to re-read `CORS_EXTRA_ORIGINS` per value, but the existing test file imports `corsOptions`/`setupCors` at module scope (line 20), and `cors.ts` has no lazy/re-read path. To exercise the env-driven origin list the test must call `jest.resetModules()` and dynamically `require` the middleware inside `isolateModules`; `jest.isolateModules` alone does not re-import a module already cached at top level, and the plan does not spell this out.

- `exafyltd/vitana-platform:services/gateway/test/middleware/cors.test.ts:17` — import { corsOptions, setupCors, sseHeaders } from '../../src/middleware/cors';

Suggestion: Specify `jest.resetModules()` + dynamic `require('../../src/middleware/cors')` inside `jest.isolateModules` for the env cases (and confirm the static corsOptions import is not reused for them), so the env parsing is actually exercised rather than the cached module.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The cors lane now specifies an env-driven append-only mechanism that preserves the regex patterns and narrow discovery rules; verified against cors.ts and the outbound-http-worker precedent.
- R1-F2: acknowledged — The planner added platform citations for the two highest-risk premises and committed build-time re-checks (AF1/header readers); the residual unpinnable-v1 risk is now scoped to non-security premises, which I re-raise at minor severity in R2-F2 for the load-bearing theme premise.
