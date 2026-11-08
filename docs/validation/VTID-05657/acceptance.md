# VTID-05657 — client-identity-gateway acceptance
Change types: Backend, Tooling/docs

- `classifyClient(headerValue): 'native' | 'web'` at `services/gateway/src/services/client-identity/classify.ts` (pure, no I/O, no Express).
- Tests `services/gateway/test/client-identity-classify.test.ts`: native iOS and Android, missing header, malformed header, unknown platform, unknown version, unparseable version. 9/9 green (`outputs/jest-client-identity.txt`).
- Red on base: module not found before `classify.ts` existed (commands.log).
- Not verified on staging: pure function, no route; the staging probe is in lane client-identity-store.
