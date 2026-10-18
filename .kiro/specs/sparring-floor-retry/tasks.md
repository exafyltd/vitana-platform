# Tasks — sparring-floor-retry

<!-- lane: floor-retry-code -->
- [ ] T1 `partner.ts`: export `codeAccessFailed`; both failure exits return `code_access_unavailable` when it holds.
- [ ] T2 `plan-sparring-service.ts`: create dedup also re-runs floor/output-invalid sessions whose round-1
      `tool_log` is all failed.
- [ ] T3 `plan-spar.mjs`: one-time legacy reclassification (`reclassified` marker) feeding the `retryInfra` path.
- [ ] T4 Tests: gateway scenarios (all-failed reads → `code_access_unavailable`; partial reads → floor kept; dedup
      bypassed only for all-failed). `plan-spar.test.mjs` (a)–(d) with `c.get` overrides and `c.calls` assertions.
- [ ] T5 Verify: node tests, both gateway Jest suites, `tsc --noEmit`. After the staging deploy, one push to
      mt-identity yields a new session with read_file-cited findings, and the session count stays 1.

Acceptance: requirements 1–4 hold, and all listed suites are green.
