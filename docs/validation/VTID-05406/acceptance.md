# VTID-05406 acceptance (sv-05308-coverage/suite)

AC-1 docs/validation/VTID-05308/staging-tests.json exists, is valid JSON, has top-level vtid=VTID-05308,
service=gateway and a tests array, and is accepted by the STAGING-VERIFY runner's loadManifest/validateManifest.
TEST: node --input-type=module -e 'import {loadManifest} from "./scripts/ci/staging-verify/run.mjs"; const m=loadManifest(process.cwd(),"VTID-05308"); if(!m||m.__parseError||m.vtid!=="VTID-05308"||m.service!=="gateway"||!Array.isArray(m.tests)) process.exit(1)'

AC-2 The suite is read-only: one rejected-probe http check (GET /api/v1/community/members, expect 401, nothing
written) and one existing ref running the two jest suites #4423 fixed (loop-catalog, plan-sparring-session-layer),
both source/text checks with no write. No new route, no production/live write.
TEST: node -e 'const m=require("./docs/validation/VTID-05308/staging-tests.json"); const k=m.tests.map(t=>t.kind); if(!(k.includes("http")&&k.includes("existing"))) process.exit(1); if(m.tests.find(t=>t.kind==="http").rejected_probe!==true) process.exit(1)'

AC-3 red→green: loadManifest(repo,"VTID-05308") is null on origin/main and the parsed suite on the lane head.
TEST: node --input-type=module -e '...'  (recorded in commands.log)

AC-4 Only docs/validation/** and the lane file change. No code, workflow, governance path or protected gate file.
The two referenced jest suites pass on main (32/32). Deploys nothing of its own; endpoint is the gateway
STAGING-VERIFY pass after the next staging deploy.
TEST: git diff --name-only origin/main...HEAD | grep -vE '^(docs/validation/|\.kiro/specs/sv-05308-coverage/lanes/suite\.md$)' && exit 1 || exit 0
