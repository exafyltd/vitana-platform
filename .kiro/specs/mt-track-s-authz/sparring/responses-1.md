# Responses to sparring round 1 (session 51e287cf-00e8-49b5-967c-773f516b79f5)

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "The feed item field is `branch`, set by `listOpenPrsWithStatus` as `branch: pr.head.ref` (services/gateway/src/services/github-service.ts:1029; function at :989), and /feed/approve reads the item as `prItem` (services/gateway/src/routes/approvals.ts:551). Plan §2 now quotes both lines, plan §4 lane approvals-auth step 2 names `prItem.branch`, and tasks A2 requires the test to build the feed item with that exact field."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Plan §4 lane work-surface-permission step 1 now fixes the resolution values: kept by the exafy_admin claim keeps the resolver's value (`declared` or `route`); kept by a permitted role gets a new ProfileResolution member `permitted` (services/gateway/src/orb/profile/assistant-profile.ts:55); refused gets `narrowed`. An authenticated session never ends `unverified`. The only consumers of the value are the profile event (live-session-controller.ts:1192) and summarizeProfiles, which counts any resolution string (orb/developer/system-snapshot.ts:89-97). Tasks W2/W3 and the acceptance States list the values."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "deferred",
    "rationale": "Closing the GET routes needs a Command Hub change in operator-console.js (it reads /pending without a header at :3116 and :3702) plus a cache-busting bump, which is a different change type from this backend slice. It is now tracked as follow-up F1 in handoff.md and named in plan §8; a VTID cannot be allocated by hand (CLAUDE.md §4.1), so it gets one when that slice is planned.",
    "deferred_to": ".kiro/specs/mt-track-s-authz/handoff.md, Follow-ups F1 (its own Track S plan)"
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "fetchPermittedRoles does not throw: a missing client, a missing user or tenant, a query error and an exception all return `{ roles: null, error }` (services/gateway/src/lib/permitted-roles.ts:41, :42, :48-49, :53-55); plan §2 now states this. Plan §4 step 2 still guards the call site with `.catch(() => ({ roles: null }))`, treats null as a refusal and makes the profile event warn. Tasks W2 add two controller cases: `roles: null` and a rejected read, both served the member surface."
  },
  {
    "finding_id": "R1-F5",
    "disposition": "rejected",
    "rationale": "Verified at the pin 900d76c485: routes/conversation.ts:216 is `const { channel, tenant_id, user_id, role, message, ui_context, vtid, options } = input;`, :497 is the prompt line `User's role: ${role}`, :502 is `const toolDefs = getGeminiToolDefinitions(role);`, :520 is `userRole: role,` and :918 is `userRole: input.role,`; services/gateway/src/services/tool-registry.ts:1364 is `export function getGeminiToolDefinitions(role: string)`. Plan §2 now quotes :216 and :502. Tasks W1 already re-checks these sites at the lane base, so no further plan change is needed."
  }
]
```
