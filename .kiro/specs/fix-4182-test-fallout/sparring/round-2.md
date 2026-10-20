# Sparring round 2 — escalated

Session: `ea4951d0-89ec-45b2-a7a8-0f431c3896a8` · plan hash `66dc27ce778ac44fa3a9bd4f4b89194a97d46b754ef3c19654a3d5967f1c030c`

## Summary

Round 2. R1-F2 (rejected) is acknowledged: staging already serves 05082 — svg-preview.js exists at svg-preview.js:85 (exported :381) and index.html:29 loads it with the 05082 cache key; STAGING-VERIFY targets staging only, so production lag is irrelevant to the corrected test. R1-F1 (accepted) is addressed and its re-verified mechanics hold: check-pr skips docs-only commits (touchesService skips docs/validation/**), and the corrected manifest is read from the deployed-commit checkout (run.mjs:202 loadManifest + STAGING-VERIFY.yml:160 target checkout at env.SHA), which the A-then-B merge order now supplies. One new real gap remains: Lane B touches services/gateway/test/** (a deploy path), so its PR is NOT docs-only — both STAGING-TESTS-REQUIRED (checkPr) and VALIDATOR-CHECK fire and impose VTID-in-title + full evidence-pack requirements the plan never specifies. As written, Lane B's PR would be blocked by CI gates, and the plan under-specifies which VTID/evidence deliverable each lane carries.

## Findings

### R2-F1 [major]

Lane B is not a docs-only change: it edits services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts, which matches the services/gateway/** deploy path (lib.cjs:42), so STAGING-TESTS-REQUIRED runs check-pr on Lane B's PR and REQUIRES a VTID in the PR title plus a valid docs/validation/<VTID>/staging-tests.json (run.mjs:474-499). Separately, VALIDATOR-CHECK's validate-pr job triggers on services/gateway/test/** AND docs/validation/** (VALIDATOR-CHECK.yml:32-37) and its Evidence Pack Gate demands docs/validation/<VTID>/{acceptance.md, commands.log, outputs/} (VALIDATOR-CHECK.yml:146-150) plus a VTID in the title (VALIDATOR-CHECK.yml:87-92, 318). The plan's Change section only says Lane B creates a read-only staging-tests.json as its 'own record' and never states what VTID Lane B's PR title carries nor that its full evidence pack (acceptance.md/commands.log/outputs/) exists. As written, following the plan literally leaves Lane B's PR red on STAGING-TESTS-REQUIRED (no title VTID) and VALIDATOR-CHECK (no evidence pack). The plan's 'How Lane A's fix gets verified' section explicitly treats Lane B's merge as the proving deploy, so this gate is load-bearing, not cosmetic.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/run.mjs:469` — const files = (git(repoRoot, ['diff', '--name-only', `${args.base}...${args.head}`]) ... if (!lib.touchesService(files, service)) { log(...); return; } const vtids = lib.extractVtids(args.title); ... if (vtids.length === 0) fail(`PR changes ${service} deploy paths but its title names no VTID ...`);
- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:41` — deployPaths: [ 'services/gateway/**', '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml' ],
- `exafyltd/vitana-platform:.github/workflows/VALIDATOR-CHECK.yml:32` — paths:
  - 'services/gateway/src/**'
  - 'services/gateway/dist/**'
  - 'services/gateway/openapi/**'
  - 'services/gateway/test/**'
  - 'docs/validation/**'
- `exafyltd/vitana-platform:.github/workflows/VALIDATOR-CHECK.yml:146` — EVID="docs/validation/$VTID"
  test -d "$EVID" || (echo "REJECTED: missing evidence dir $EVID" && exit 30)
  test -f "$EVID/acceptance.md" || (echo "REJECTED: missing $EVID/acceptance.md" && exit 31)
  test -f "$EVID/commands.log"  || (echo "REJECTED: missing $EVID/commands.log" && exit 32)
  test -d "$EVID/outputs"       || (echo "REJECTED: missing $EVID/outputs/" && exit 33)

Suggestion: State explicitly, per lane, the PR-title VTID and the full evidence deliverables. For Lane B: name the VTID its PR title will carry, and list creating docs/validation/<VTID>/{staging-tests.json, acceptance.md, commands.log, outputs/} so both check-pr (title VTID + valid manifest) and VALIDATOR-CHECK (evidence pack) pass. For Lane A: state that its PR reuses VTID-05082 (whose acceptance.md/commands.log/outputs/ already exist) or, if it names a new VTID, that it must also create the full pack. Otherwise the A-then-B merge order and its 'Lane B merge is the proving deploy' logic cannot proceed because Lane B cannot merge green.

### R2-F2 [minor]

The plan pins the corrected Lane B assertion to the literal string '/command-hub/app.js?v=20261121-vtid-05082' and correctly notes a later bump must update it, but it does not flag that VALIDATOR-CHECK's Evidence/Acceptance gates and the vtid-05082-svg-render.test.ts already reference the same cache-busting string family, nor that the plan's own Lane B staging-tests.json (GET /command-hub/index.html contains app.js?v=20261121-vtid-05082) hardcodes the same token and will need the same coordinated update on any future bump. This is informational only (no gate is violated today), but the plan's Out-of-scope note ('turning cache-key pins into regexes') could be understood to waive consistency across these three now-coupled pins.

- `exafyltd/vitana-platform:services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:211` — const html = fs.readFileSync(path.join(__dirname, '../src/frontend/command-hub/index.html'), 'utf8');
  expect(html).toContain('/command-hub/app.js?v=20261120-vtid-05148');
- `exafyltd/vitana-platform:docs/validation/VTID-05082/staging-tests.json:20` — path": "/command-hub/index.html",
  expect_status": 200,
  expect_body_contains": "operator-console.js?v=20261121-vtid-05082",

Suggestion: Optional: add a one-line note that the app.js cache-key pin is now present in three places (vtid-05077 test :212, VTID-05082 index.html, and Lane B's own staging-tests.json) and that a future bump must update all three; no action required to land the current fix.

## Acknowledgements of earlier responses

- R1-F2: acknowledged — The rejection is sound. svg-preview.js genuinely contains sanitizeSvgMarkup (svg-preview.js:85, exported :381) and index.html:29 loads it at the 05082 cache key. STAGING-VERIFY targets staging only (run.mjs stagingStamp uses STAGING_TARGETS.gateway), so production being at 4e0e7d1f does not affect whether test #3 passes on staging; it only keeps 05082 in the production..staging range so the suite runs. My prior 'production does not serve it yet' objection was mis-scoped.
- R1-F1: acknowledged — Accepted and addressed. The revision's new section correctly states Lane A is docs-only with no Gate 2, and the A-then-B merge order supplies a deployed commit containing the corrected manifest, whose STAGING-VERIFY run (loadManifest from the target checkout at the deployed SHA, STAGING-VERIFY.yml:160) is the evidence for both lanes. The fallback (nightly full run on deployed commit) is correctly stated if Lane B ends empty. Re-verified that the mechanics hold in code.
