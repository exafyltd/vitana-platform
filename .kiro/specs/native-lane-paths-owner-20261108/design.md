# Design — lane paths for two owner-approved native test edits (native-lane-paths-owner-20261108)

`scripts/collab/queue.mjs` scopeCheck reads a lane's `paths` from the trusted revision (merge-base, never the PR head), so
a lane PR cannot widen its own paths. `laneAdminCovers(repo, base, head, key, lanePath, …)` lets a lane that is trusted on
main (`executor: kiro`, `reviewer_seat` the reviewer agent, `lane_admin: true`) change the permission fields of a TARGET
lane file when its own `paths` cover that file. The admin lane's `paths` list the two target lane files and never its own
file, so `targetOfAdmin` is false for the admin lane's own permission fields (it cannot self-widen).

Edit to each target: only the `paths:` list, adding the lines in `requirements.md` R1. Everything after the added lines is
byte-identical; a byte check (`diff` of base and head restricted to the target) shows exactly three added lines in total.
Precedents: `agentic-delivery/nav-paths` (added four paths to `gateway-delivery`, VTID-05563, merged as 7ec024340a) and
`say-hello-lane-reassign/reassign` (VTID-05410). `collaboration.md` §7a (line 250, "Lane administration") says "narrow"; R1 of `kiro-lane-admin` says
"add/narrow", and `queue.mjs` accepts any permission-field change by a covered target — recorded, as the reviewer
noted for VTID-05563.
