# Acceptance - VTID-05206 closing record (lane new-member-welcome/new-member-card-optin, verified -> done)

Change types: Tooling/docs.

Additional file; earlier evidence is not changed. This PR only moves the lane `verified` -> `done` after its verified record
(#4510, merge 85d95454d2) reached main. Nothing deploys.

AC-1: The lane moves `verified` -> `done`; `next_actor`, `claimed_by`, `seat`, `depends_on` and `vtid` unchanged.
  TEST: node scripts/collab/queue.mjs validate --base origin/main --head HEAD --repo .

AC-2: The change stays inside the lane file and this evidence directory.
  TEST: node scripts/collab/queue.mjs scope-check --base origin/main --head HEAD --repo . --branch kiro/close/new-member-welcome/new-member-card-optin-done

AC-3: Every required governance check passes before push (output: outputs/done-preflight.txt).
  TEST: node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch kiro/close/new-member-welcome/new-member-card-optin-done --title "<PR title>"
