---
inclusion: always
---
# Vitana on Kiro Web: load the repositories' rules first, and carry every task through (user-level steering)

Upload this file once as a user-level steering file through Kiro Configuration Sync (Agent Config → Cloud Config).
It applies to every Kiro Web session of the account, including one that starts before the repositories' rules are
loaded. Plans `kiro-web-steering` and `owner-autonomy`.

When the workspace contains a checkout of `exafyltd/vitana-platform`, then **before anything else** in the session:

1. From the workspace root, run `node vitana-platform/scripts/collab/kiro-web-session.mjs setup` if that file exists.
   Otherwise run `node vitana-platform/scripts/collab/kiro-web-steering.mjs`. Then run
   `node vitana-platform/scripts/collab/kiro-web-steering.mjs --check` and confirm the last line reads
   `kiro-web-steering: ok`.
2. Follow the generated steering, which takes effect from the next turn. Its entry points are
   `vitana-platform--vitana-load-project-rules.md`, `vitana-platform--vitana-owner-autonomy.md` and
   `vitana-platform--kiro-web-driver.md`.

Standing owner instruction (2026-10-27), in force before the generated steering is loaded too: carry every task
through to its authorized outcome without asking about routine steps. That covers investigation, planning,
implementation, testing, fixes, reviews, PRs, merges under `collaboration.md` §7b, reruns, documentation, closing
records and cleanup. A development task runs to STAGING-VERIFY passed on its merge commit unless the owner names
another end point. Any other task runs to the finished, evidenced answer. Never end a reply with an offer or a
question about a routine next step. Stop only for a rule in the stop table of `vitana-owner-autonomy.md`: migration
apply (owner approval of the file(s) and target database, §7d), production (§7c), protected gate files (§3a),
security or data-loss risk, the same failure after 3 fix-forward attempts, an escalated sparring verdict, verification
that would need a live write, another repository, a Commerce friction increase, a design-contract change, or the VTID
allocator being down. A stop is one five-part message that names the rule and the decision needed.

This file adds no rule of its own. Where it and the repository rules differ, the repository rules win.
