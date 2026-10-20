# Sparring round 1 — in_progress

Session: `ea4951d0-89ec-45b2-a7a8-0f431c3896a8` · plan hash `8072ddf0f22566e08843647892cc1fa5986615b3694595fecd758c1aa5685190`

## Summary

The plan is fundamentally sound: both fixes are indeed stale test expectations, and the claim that the product code is correct is verified. I confirmed the core premises against pinned code: sanitizeSvgMarkup lives in svg-preview.js:85 (not operator-console.js), index.html:32 pins app.js?v=20261121-vtid-05082 (and :29 loads svg-preview.js), the Jest test at :212 still pins 20261120-vtid-05148, and loadManifest reads the manifest from the checkout so a corrected file on main takes effect on the next run. The two edits themselves are minimal and correct.

However, there is one genuine governance defect in Lane A worth flagging before implementation: the gateway check-pr/staging-verify gate (`touchesService`) only treats `services/gateway/**` and the workflow yml as deploy paths. `docs/validation/**` is NOT a deploy path, so the Lane A PR (which only touches docs/validation/VTID-05082/staging-tests.json plus a new docs record) will never trigger check-pr, never carry a verified VTID into the deploy range, and the corrected manifest only "takes effect on the next run" when an *unrelated* gateway-deploy commit happens to land and trigger a verify. This is a correctness-by-side-effect gap the plan acknowledges implicitly but under-weights. Also note the corrected test #3 asserts svg-preview.js is served with sanitizeSvgMarkup, but that module is only on main (production is at 4e0e7d1f, before 05082); until a gateway deploy actually lands and rolls staging past 05082, the corrected test itself cannot pass — so the "blocks Gate 2" claim requires a shipping gateway commit in the range, which the manifest-editing lane does not provide.

## Findings

### R1-F1 [major]

Lane A edits an already-shipped VTID's manifest under docs/validation/VTID-05082/, but that path is outside the gateway deploy-path set, so the lane's own PR will not trigger check-pr nor STAGING-VERIFY. The corrected manifest only takes effect when an unrelated gateway-deploy commit later lands and triggers a verify run. The plan's 'takes effect on the next run' relies on a side-effect that Lane A itself does not guarantee, and the plan does not state how the fix becomes verified as its own change.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:41` — deployPaths: [ 'services/gateway/**', '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml' ]
- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:102` — function touchesService(files, service) { ... return files.some((f) => cfg.deployPaths.some((p) => pathMatches(f, p))); }

Suggestion: State explicitly in the plan how Lane A's fix is gated/attributed. Either (a) accept that the lane's PR is a docs-only change that rides on the next gateway deploy and document who verifies it; or (b) carry the manifest edit in a commit whose subject also carries a valid VTID and note that check-pr only fires for services/gateway/** changes, so the Lane A VTID will not itself be range-verified. Ensure the plan does not silently claim the suite 'blocks Gate 2' for Lane A's own commit.

### R1-F2 [major]

The corrected VTID-05082 test #3 asserts staging serves svg-preview.js containing sanitizeSvgMarkup, but production is at 4e0e7d1f (before VTID-05082), so production does not yet serve svg-preview.js. Until a gateway deploy actually rolls staging (and later production) past 05082, the corrected assertion cannot pass on its own. The plan correctly identifies that the suite is 'in every release range', but the fix's effectiveness depends on a separate shipping gateway commit existing in the range, which Lane A (docs-only) does not provide.

- `exafyltd/vitana-platform:services/gateway/src/frontend/command-hub/index.html:29` — <script src="/command-hub/svg-preview.js?v=20261121-vtid-05082"></script> ... <script src="/command-hub/app.js?v=20261121-vtid-05082"></script>
- `exafyltd/vitana-platform:docs/validation/VTID-05082/staging-tests.json:25` — name: deployed operator-console.js contains the SVG sanitizer/renderer ... path: /command-hub/operator-console.js?v=20261121-vtid-05082 ... expect_body_contains: sanitizeSvgMarkup

Suggestion: Document the dependency explicitly: the fix to test #3 is only green once a gateway-deploy commit in the range has shipped svg-preview.js. If no such commit is pending in the release range, the corrected test will still fail (because svg-preview.js is not yet in production-facing staging), which would change the failure mode but not unblock Gate 2 until 05082 actually ships. Ensure the plan's 'Lane A' verification step (a manual GET of svg-preview.js returning 200 + sanitizeSvgMarkup) reflects the CURRENT staging state, not a hypothetical post-deploy state.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
