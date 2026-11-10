# VTID-05657 — client-identity-gateway acceptance
Change types: Backend, Tooling/docs

Outcome: the gateway can classify a request as native or web from the `X-Vitana-Client` header with a pure function.
States: well-formed native header (iOS, Android) is native; missing, malformed, unknown platform, unknown version and unparseable version are web.
Surfaces: services/gateway/src/services/client-identity/classify.ts (pure, no I/O, no Express).
Locales: n/a. Accessibility: n/a.
Staging proof: not verified on staging: pure function, no route; the staging probe is in lane client-identity-store.

AC-1 — `classifyClient(headerValue): 'native' | 'web'` returns native for a well-formed native iOS or Android header
  TEST: services/gateway/test/client-identity-classify.test.ts (native iOS, native Android)

AC-2 — a missing, malformed, unknown-platform, unknown-version or unparseable-version header is classified web
  TEST: services/gateway/test/client-identity-classify.test.ts (missing, malformed, unknown platform, unknown version, unparseable version; 9/9 green, outputs/jest-client-identity.txt)

AC-3 — the module is pure: no I/O, no Express import; red on base because the module did not exist
  TEST: services/gateway/test/client-identity-classify.test.ts (module not found before classify.ts existed, see commands.log)
