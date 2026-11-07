# Acceptance - VTID-05208 closing record (lane new-member-welcome/grouped-welcome-notifications, verified -> done)

Change types: Tooling/docs.

Additional file; earlier evidence is not changed. This PR only moves the lane `verified` -> `done` after its verified record
(#4511, merge cf009eca8f) reached main. Nothing deploys.

AC-1: The lane moves `verified` -> `done`; `next_actor`, `claimed_by`, `seat`, `depends_on` and `vtid` unchanged.
  TEST: node scripts/collab/queue.mjs validate --base origin/main --head HEAD --repo .

AC-2: The change stays inside the lane file and this evidence directory.
  TEST: node scripts/collab/queue.mjs scope-check --base origin/main --head HEAD --repo . --branch kiro/close/new-member-welcome/grouped-welcome-notifications-done

AC-3: Every required governance check passes before push (output: outputs/done-preflight.txt).
  TEST: node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch kiro/close/new-member-welcome/grouped-welcome-notifications-done --title "<PR title>"
