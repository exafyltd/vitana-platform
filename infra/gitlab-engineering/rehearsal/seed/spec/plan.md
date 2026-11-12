---
change_class: standard
---
# plan(rehearsal): the scratch spec of the GitLab rehearsal

A spec with twelve lanes, one for each agent of the rehearsal (plan eng-gitlab-m2, section 3.8). Nothing here is a real plan: the merge bot
of the self-hosted GitLab lands the merge requests of these lanes, and the report of `scripts/eng/rehearse.mjs` says whether it did so
correctly. A merge request for a lane adds one source file under `src/lanes/` and one test under `test/lanes/`; no two lanes touch the same
file, so the merge requests never conflict and the bot can land them one by one.

<!-- plan:begin -->
Lanes lane-01 to lane-12 (one agent each) and the lane `seed` (the merge request that puts this repository on main).
<!-- plan:end -->
