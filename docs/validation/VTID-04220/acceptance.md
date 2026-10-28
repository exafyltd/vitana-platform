# VTID-04220 — Env-aware gateway base URL for the verifying-stage probe and the self-healing probe

## Root cause

Two probe sites carried their own gateway literal:

- `dev-autopilot-execute.ts` `reconcileVerifying`: `process.env.GATEWAY_URL ||
  'https://gateway-q74ibpv6ia-uc.a.run.app'` — the GCP Cloud Run gateway
  deleted on 2026-08-16 (CLAUDE.md §1: a live `*.run.app` reference is dead
  code). `GATEWAY_URL` is not pinned on the AWS gateway task definitions by
  any tracked workflow, so when the 60-minute verifying reconciler reaches
  its `/alive` probe it probes a dead host, fails the execution, and the
  bridge reverts the merge.
- `self-healing-probe.ts`: `process.env.GATEWAY_URL ||
  'https://gateway.vitanaland.com'` — production. The verification watcher's
  endpoint re-probe passes no base URL, so a staging execution's finding
  endpoint was probed against production.

## Fix

`env.ts` gains `GATEWAY_URLS` and `gatewayBaseUrl(env = process.env)`:
`GATEWAY_URL` when set (trailing slash stripped), otherwise
`preview-aws-gateway.vitanaland.com` for `VITANA_ENV=staging` and
`gateway.vitanaland.com` otherwise. Both probe sites call it at call time.

## Acceptance Criteria

AC-1 — `gatewayBaseUrl` follows VITANA_ENV, prefers an explicit GATEWAY_URL, strips a trailing slash, and never names a GCP host.
TEST: services/gateway/test/vtid-04220-gateway-base-url.test.ts — the three "gatewayBaseUrl" cases (`npx jest services/gateway/test/vtid-04220-gateway-base-url.test.ts`).

AC-2 — `dev-autopilot-execute.ts` carries no `run.app` literal and resolves the probe URL through `gatewayBaseUrl()`; `self-healing-probe.ts` defaults through it at call time.
TEST: services/gateway/test/vtid-04220-gateway-base-url.test.ts — the two "source contract" cases.

AC-3 — On a staging process with GATEWAY_URL unset, `probeEndpoint('/api/v1/…')` targets preview-aws-gateway.
TEST: services/gateway/test/vtid-04220-gateway-base-url.test.ts — "joins a relative endpoint onto preview-aws-gateway…".

AC-4 — Existing probe behaviour unchanged.
TEST: services/gateway/test/self-healing-pre-probe.test.ts, test/self-healing-reconciler-autopilot-link.test.ts (re-run green).

## Verification

- `tsc --noEmit` (services/gateway): clean.
- New suite 6/6; sibling suites 29/29.

## Not verified

No live reconciler probe was observed (the watcher owns `verifying` at 5 minutes; the reconciler only reaches this probe when the watcher is down for an hour). The staging task definition's inherited `GATEWAY_URL`, if any, was not read from AWS in this session.
