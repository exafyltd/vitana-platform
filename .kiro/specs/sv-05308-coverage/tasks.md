# Tasks — sv-05308-coverage
Authoritative plan: `plan.md`. VTID from CI PLAN-SPAR. Branch `kiro/sv-05308-coverage/suite`; title
`VTID-xxxxx (sv-05308-coverage/suite): …`; trailers; `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: suite -->
## Lane `suite`
- [ ] T1 Add `docs/validation/VTID-05308/staging-tests.json` per plan §3: `service: gateway`, one rejected-probe
      `http` check (expect 401, nothing written) and one `existing` ref running `test/loop-catalog.test.ts` and
      `test/vtid-04868-plan-sparring-session-layer.test.ts` in `services/gateway`.
- [ ] T2 Validate: JSON parses; the runner's `loadManifest` returns the parsed suite (red on base = null); the two
      jest suites pass in `services/gateway`. Record in `docs/validation/VTID-05308/commands.log` (append) and the
      lane's own `docs/validation/<VTID>/` evidence.

**Acceptance**
- `docs/validation/VTID-05308/staging-tests.json` is valid and accepted by `scripts/ci/staging-verify/run.mjs`
  (`loadManifest` / validate), with `service: gateway`, a read-only probe and an `existing` ref only.
- The referenced jest suites are the ones #4423 fixed and pass on `main`.
- Only `docs/validation/**` changes. No code, workflow, governance path or protected gate file. Deploys nothing of
  its own; the endpoint is the gateway STAGING-VERIFY pass after the next staging deploy.
