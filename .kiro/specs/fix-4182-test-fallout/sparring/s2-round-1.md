# Sparring round 1 — in_progress

Session: `f3ffa6df-ea61-477c-a7c7-4bfea858d756` · plan hash `a574329cd30807b8d158e2a4fd96a757b1cb37f15169d9f82eb1c06414eb26db`

## Summary

The plan is sound and unusually well-evidenced. Both stale-test claims are correct against the pinned code: (A) `sanitizeSvgMarkup` lives in svg-preview.js:85 (exported :381), not operator-console.js, and index.html:29 loads svg-preview.js; (B) index.html:32 ships `app.js?v=20261121-vtid-05082` while the 05077 test still pins `20261120-vtid-05148` at :212. The CI-flow claims (VALIDATOR-CHECK triggers on docs/validation/** and services/gateway/test/**; STAGING-TESTS-REQUIRED's check-pr returns early for non-deploy paths; VTID-04696 enforces version-pin consistency across every staging-tests.json; planRange/loadManifest semantics) all hold against the workflow and runner source. No blocker or major defect found. Two minors: (1) the old app.js key also survives as prose in VTID-05148/acceptance.md:13, outside the plan's "three places" enumeration and B5's grep scope (harmless, not a suite pin); (2) Lane A's own VTID-A staging-tests.json full-manifest validity is never mechanically enforced (check-pr skips a docs-only PR, and VTID-04696 only scans version pins), so the plan's "held to the same validity" claim slightly overstates coverage.

## Findings

### R1-F1 [minor]

Task B5's grep ('no positive toContain/suite pin of app.js?v=20261120-vtid-05148 remains') and the R2-F2 'three places' enumeration miss that the old key also survives as prose in docs/validation/VTID-05148/acceptance.md:13 (CURL_PROOF text). This is not a suite pin and is not read by VTID-04696 (which only parses staging-tests.json files), so it cannot fail any gate — but the plan's assertion that no positive pin remains is imprecise about its own grep scope.

- `exafyltd/vitana-platform:docs/validation/VTID-05148/acceptance.md:13` — CURL_PROOF: GET `/api/v1/autonomy/pulse` and `/api/v1/autonomy/loops` unauthenticated on staging → 401 JSON; GET `/command-hub/` carries `app.js?v=20261120-vtid-05148` and `loops-catalog.js?v=20261120-vtid-05148` (staging-tests.json).
- `exafyltd/vitana-platform:services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts:36` — for (const dir of fs.readdirSync(VALIDATION_DIR)) { const file = path.join(VALIDATION_DIR, dir, 'staging-tests.json'); if (!fs.existsSync(file)) continue;

Suggestion: Clarify that B5's grep targets staging-tests.json suite pins and test toContain assertions only, and that VTID-05148/acceptance.md:13 is descriptive prose out of scope (or note it as a known benign leftover not covered by any gate).

### R1-F2 [minor]

The plan states Lane A's VTID-A staging-tests.json is 'held to the same validity because the VTID-04696 test reads every suite.' This overstates coverage: VTID-04696 only scans version pins (asset?v=...) against index.html, not the rest of the manifest shape. check-pr loadManifest/validateManifest never runs for Lane A because docs/validation/** is not a gateway deploy path (run.mjs:470-472 returns early). So VTID-A's pack fields (kind, expect_body_contains string, existing ref, service) are never mechanically validated — the pack is a record only, which is acceptable but should be stated accurately.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:469` — const files = (git(repoRoot, ['diff', '--name-only', `${args.base}...${args.head}`]) || '').split('\n').filter(Boolean); if (!lib.touchesService(files, service)) { log(`PR touches no ${service} deploy path — nothing deploys, no staging suite needed.`); return; }
- `exafyltd/vitana-platform:services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts:35` — const re = /(?<![A-Za-z0-9_-])([a-z0-9_-]+\.(?:js|css))\?v=([A-Za-z0-9._-]+)/g; ... const want = served.get(m[1]); if (!want) stale.push(...) else if (want !== m[2]) stale.push(...)

Suggestion: Reword to say VTID-A's staging-tests.json is checked for version-pin consistency by VTID-04696, not 'the same validity'; optionally add a manual JSON.parse + validateManifest step to Lane A's verification so the record pack is structurally sane before merge.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
