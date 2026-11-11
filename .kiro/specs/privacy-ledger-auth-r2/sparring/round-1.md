# Sparring round 1 — in_progress

Session: `da423ee9-00fd-470d-b67a-3a33427075bb` · plan hash `2cc05384da8b4537b721e77c78b5744b7a29255343005de31c3bd4fa278c6964`

## Summary

The plan is well-structured and addresses a clear operational need (enforcing ledger write auth on production) with a safe two-phase approach: first ship the plumbing (defaulting to the current `log` mode), then flip via a repo variable at the owner's discretion. I verified the key premises against the pinned commit and they all hold. The areas-emails lane is low-risk and straightforward. I found one minor discrepancy and no blockers or major issues.

## Findings

### R1-F1 [minor]

The plan states its premises were verified against commit `6dc6e1ba0c`, but the review is pinned at `a9a36a8e1dfb2bd74a04c18b09ae8a9b53baed04`. These are different commits. All premises I checked still hold against the pinned commit, but the plan text should reference the actual commit the implementation will run against, to avoid confusion if files drift between the two.

- `exafyltd/vitana-platform:docs/programs/areas.yaml:14` — seats:\n  jtadic:   { account: j.tadic@exafy.io, ...
- `exafyltd/vitana-platform:services/gateway/src/middleware/ledger-write-auth.ts:39` — export function resolveLedgerWriteAuthMode(raw = process.env.LEDGER_WRITE_AUTH_MODE): LedgerWriteAuthMode {\n  const v = String(raw ?? '').trim().toLowerCase();\n  if (v === 'enforce') return 'enforce';\n  if (v === 'off') return 'off';\n  return 'log';\n}

Suggestion: Update the plan's stated premise commit to match the pinned review commit, or confirm explicitly that all premises hold at the pinned commit. This is cosmetic if nothing changed between the two, but prevents a stale-premise surprise if something did.

### R1-F2 [minor]

The lane `ledger-auth-enforce` lists its paths as three files (the prod workflow, the test, and the generated flag-pins file), but the plan also says "The lane's `staging-tests.json` adds one `http` `rejected_probe`". If `staging-tests.json` is a separate file written by the lane (e.g. under `docs/validation/` or a CI directory), it is not declared in the Paths column of the Lanes table.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:372` — // VTID-05083: the request init for one http test. A rejected probe carries a\n// deliberately invalid bearer; only a write method also gets a JSON body —\n// fetch refuses a GET/HEAD with a body before anything is sent.\nfunction httpRequestInit(t) {

Suggestion: Clarify whether `staging-tests.json` is a lane-output file that needs to be in the Paths column, or is generated/consumed implicitly by the CI framework and exempt from path tracking.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
