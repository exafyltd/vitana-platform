---
inclusion: always
---
# Session title: set once, never renamed (owner rule, plan session-title-stable)

The owner reads the session title to know what a session was started for. Renaming it loses that.

1. Set the session title once, at the start, from the owner's original request (what the session was started for).
2. Never change it later: not when the focus shifts, a sub-task starts or ends, the session is blocked, waiting for
   the owner, or done.
3. Never put a state in the title: no "Blocked:", "Waiting:", "Done:" or similar prefix or suffix. Report state only
   through the session status (`waiting_on_user`, `completed`) and the session description, which may change.
4. Change the title only when the owner explicitly asks for it in that session.
5. This applies to every Kiro session on Vitana: Kiro Web, Kiro IDE and automation-started drivers.

This file is byte-identical in vitana-platform and vitana-v1; change both together.
