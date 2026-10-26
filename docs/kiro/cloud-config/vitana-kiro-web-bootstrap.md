---
inclusion: always
---
# Vitana on Kiro Web: load the repositories' rules first (user-level steering, plan kiro-web-steering)

Upload this file once as a user-level steering file through Kiro Configuration Sync. It applies to every Kiro Web
session of the account.

When the workspace contains a checkout of `exafyltd/vitana-platform`, then **before anything else** in the session:

1. If `.kiro/steering/vitana-platform--vitana-load-project-rules.md` does not exist at the workspace root, run
   `node vitana-platform/scripts/collab/kiro-web-steering.mjs` from the workspace root (it writes the repos' steering,
   with paths fixed for the workspace root, into `.kiro/steering/`). Then run it again with `--check` and confirm the
   last line reads `kiro-web-steering: ok`.
2. Follow the generated steering, which takes effect from the next turn. Its entry points are
   `vitana-platform--vitana-load-project-rules.md` and `vitana-platform--kiro-web-driver.md`. Every owner task that
   results in a commit runs the pipeline end to end under those rules. The owner is asked only what those rules name
   as owner stops.

This file adds no rule of its own. Where it and the repository rules differ, the repository rules win.
