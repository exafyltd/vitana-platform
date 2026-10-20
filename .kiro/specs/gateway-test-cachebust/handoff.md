---
slug: gateway-test-cachebust
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-10-20T10:25Z
---
# Handoff — gateway-test-cachebust

One stale cache-bust pin in a VTID-05077 gateway test keeps `main`'s gateway Jest red; VTID-05082 (#4182) bumped the
tag and missed this test. Plan: `plan.md`. Lane: `fix-pin` (seat exafy, reviewer jtadic).

## Log

### 2026-10-20T10:25Z · kiro-exafyltd-202610201024-84c9 · drafted
Owner instruction 2026-10-20: everything by Kiro end to end. Found while reviewing #4198 (VTID-05238), whose gateway
Jest checks inherit this red from `main`. Pushed as a `plan(` PR for PLAN-SPAR. No VTID, no product code.
