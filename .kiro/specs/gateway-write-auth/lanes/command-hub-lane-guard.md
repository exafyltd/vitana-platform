---
lane: command-hub-lane-guard
state: ready
next_actor: claude
executor: claude
depends_on: []
repos: [exafyltd/vitana-platform]
paths:
  - scripts/ci/command-hub-ownership-guard.js
  - services/gateway/test/scripts/command-hub-ownership-guard.test.ts
updated: 2026-11-17T15:10Z
---
# Lane — command-hub-lane-guard

Goal (plan §2 Lane A): the Command Hub ownership guard authorises a frontend edit from the lane declaration, not only
from the static `ALLOWED_VTID_PATTERN` list. A PR title or branch that names a VTID whose lane file declares `paths:`
covering every changed Command Hub file is authorised. The historical list stays for shipped VTIDs.

Acceptance: the tests in plan §4 Lane A pass; the guard exits 0 on a lane-declared frontend change and 1 otherwise.
