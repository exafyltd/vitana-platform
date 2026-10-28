# Sparring round 2 — converged

Session: `f3ffa6df-ea61-477c-a7c7-4bfea858d756` · plan hash `29d596b5a184228664514b713581d2b99b26e0fb013b200868a0b27345b1d7e3`

## Summary

Round 2: I verified the new/changed premises introduced by this revision against the pinned commit. The core mechanics all hold: `validateManifest` is defined at lib.cjs:187 and exported at :722; `sanitizeSvgMarkup` is defined at svg-preview.js:85 and exported at :381 (the corrected line cite); index.html:32 carries app.js?v=20261121-vtid-05082 and :29 loads svg-preview.js?v=20261121-vtid-05082; the stale test pins the old key at :212; VTID-05082 staging-tests.json test #3 still targets operator-console.js with expect_body_contains sanitizeSvgMarkup; VALIDATOR-CHECK triggers on services/gateway/test/** and docs/validation/** with the gateway_backend profile allowlisting both and the command_hub_frontend Build Gate demanding src+dist; check-pr returns early for docs-only PRs; VTID-04696 reads only staging-tests.json and matches asset?v= pins against index.html; AWS-STAGE-DEPLOY-GATEWAY triggers on push to main for services/gateway/** (so Lane B's test-only merge does deploy, as the plan intends); the EXISTING_REF regex accepts `npx jest <paths>`; and queue.mjs allows a `_plan` commit to create but not edit a lane file. Both round-1 findings were accepted and are addressed in the revision (B5 grep scope named exactly, Lane A 'held to the same validity' claim corrected with a local validateManifest task A6). No rejected/deferred findings remain to dispute. I raise one minor precision finding about the under-specified existing ref value for Lane A's record suite.

## Findings

### R2-F1 [minor]

Lane A's evidence-pack spec names its record staging-tests.json `existing` test only as 'the VTID-04696 Jest test', with no concrete ref string or reason. `validateManifest`'s `existing` branch requires `ref` to match EXISTING_REF (`npx jest <paths>` / `npx vitest run <paths>` / `npm run <script>`) AND `reason` to be a non-empty string of >=10 chars (lib.cjs:169-179). Task A6 will surface any failure by hand, so this is not a gate-blocking risk, but the plan that elsewhere pins exact strings (file:line for every pin) leaves this one value as prose that a reader could transcribe as a non-matching ref.

- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:169` — case 'existing': { const errors = []; if (typeof t.ref !== 'string' || !EXISTING_REF.test(t.ref)) { errors.push(`${where}: ref must be "npm run <script>", "npx jest <paths>" or "npx vitest run <paths>"`); } ... if (typeof t.reason !== 'string' || t.reason.trim().length < 10) { errors.push(`${where}: reason must say why this suite covers the change`); } return errors; }
- `exafyltd/vitana-platform:scripts/ci/staging-verify/lib.cjs:123` — const EXISTING_REF = /^(npm run [\w:.-]+|npx (jest|vitest run)( [\w./@:=-]+)*)$/;

Suggestion: Specify Lane A's `existing` test concretely, e.g. `ref: "npx jest test/vtid-04696-staging-checks-follow-asset-bumps.test.ts"`, cwd `services/gateway`, plus a matching `reason` >=10 chars — mirroring the exact shape given for Lane B's existing ref, so task A6's validateManifest and any later mechanical read pass unambiguously.
