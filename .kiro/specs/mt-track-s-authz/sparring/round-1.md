# Sparring round 1 — in_progress

Session: `51e287cf-00e8-49b5-967c-773f516b79f5` · plan hash `fd989ce5091d1e3ce1abb89650d481285ce49ffc8cc40c85f6598cbda801b3aa`

## Summary

I verified three key premises against the pinned code. The approvals mount, missing auth middleware, and assistant-profile surface-to-role mapping all hold. Several files became inaccessible (403) during the review, preventing full verification of premises about the conversation text path, developer-tools identity forwarding, permitted-roles, and the LiveKit/orb-tool routes. I raise findings for what I could and could not verify, plus one logic-level concern about the /feed/approve branch-mismatch fix.

## Findings

### R1-F1 [major]

The /feed/approve branch-mismatch check compares body.branch against the feed item's branch, but the plan does not specify which field from listOpenPrsWithStatus is used. The existing code at line 531 takes `branch` from req.body and uses it directly as `head_branch` in the merge payload (line 579) without comparing it to the PR's own head branch. The plan says listOpenPrsWithStatus returns the PR's branch (citing github-service.ts:989-1030), but I could not verify this file (403). If the field name returned by listOpenPrsWithStatus is not `branch` (e.g. `head_branch` or `head.ref`), the proposed comparison will silently pass or always fail. The implementation must explicitly document and test the exact property name from the feed item.

- `exafyltd/vitana-platform:services/gateway/src/routes/approvals.ts:529` — const { pr_number, repo = 'exafyltd/vitana-platform', branch, vtid } = req.body; ... head_branch: branch,

Suggestion: In the implementation, confirm the exact property name on the listOpenPrsWithStatus item (likely `prItem.branch` or `prItem.head_branch`), use that for the comparison, and add a test case that the 400 fires when body.branch !== prItem.<actual_field>.

### R1-F2 [major]

Lane work-surface-permission step 2 adds fetchPermittedRoles inside live-session-controller.ts after profile resolution (~line 1187). The plan says this is skipped for exafy_admin, but the existing profile resolution already marks non-exafy command-hub sessions as 'unverified' (assistant-profile.ts:117-119). After this plan, a non-exafy-admin caller with a valid permitted role (e.g. 'developer') on the command-hub surface will go from resolution 'unverified' to what — 'declared'? 'verified'? The plan does not specify how the resolution tag changes, yet downstream consumers (telemetry, any future code gating on 'unverified') will see a different value. The plan should specify the new resolution value for the permission-checked path.

- `exafyltd/vitana-platform:services/gateway/src/orb/profile/assistant-profile.ts:110` — const resolution: ProfileResolution = surface === 'command-hub' && !input.isExafyAdmin ? 'unverified' : surfaceWasDeclared ? 'declared' : 'route';

Suggestion: Define a new resolution value (e.g. 'permitted') or reuse 'declared' for sessions where verifyWorkSurfaceProfile confirms the role from permitted-roles. Document which resolution values the new code emits, so telemetry consumers and any gating code can distinguish verified-by-permission from the old 'unverified'.

### R1-F3 [minor]

The plan leaves the three approvals GET routes (/count, /pending, /feed) unauthenticated and notes this as a follow-up. These routes return PR metadata (titles, branches, VTIDs, CI status). While read-only, unauthenticated access to internal PR/deployment metadata is an information disclosure surface. The plan correctly flags this but does not assign a tracking item.

- `exafyltd/vitana-platform:services/gateway/src/index.ts:818` — mountRouterSync(app, '/api/v1/approvals', approvalsRouter, { owner: 'approvals-api' });

Suggestion: Record a follow-up VTID in the plan (or in the PR description) so the unauthenticated GET routes get tracked for a future auth pass, rather than being an open-ended 'follow-up'.

### R1-F4 [major]

The plan's work-surface-permission lane step 1 says verifyWorkSurfaceProfile narrows to member profile when permittedRoles is null (the unreadable case from fetchPermittedRoles). This is fail-closed, which is correct. However, the plan also says fetchPermittedRoles is 'read, not changed' and returns 'roles: null when unreadable'. I could not verify the fetchPermittedRoles implementation (403 on permitted-roles.ts). If fetchPermittedRoles throws instead of returning null on a database error, the session-start handler must catch that or risk a 500. The plan should specify error handling for the fetchPermittedRoles call site.

- `exafyltd/vitana-platform:services/gateway/src/orb/live/session/live-session-controller.ts:1181` — const assistantProfile = resolveAssistantProfile({ declaredSurface: (body as any).surface, declaredViewRole: (body as any).view_role, ...

Suggestion: Wrap the fetchPermittedRoles call in a try/catch at the controller call site. On error, treat as null (narrowed to member) and emit a warning OASIS event. Verify in the test suite that a DB error path narrows correctly.

### R1-F5 [minor]

The plan's text-path fix (lane work-surface-permission step 4) references conversation.ts lines 216, 497, 502, 520, 918 and the tool-registry getToolsForRole at line 1364, but I was unable to verify any of these due to persistent 403 errors on conversation.ts. The ConversationTurnRequestSchema.role default of 'user' is confirmed (types/conversation.ts:71). The plan should be re-verified for exact line numbers if these have shifted in recent commits.

- `exafyltd/vitana-platform:services/gateway/src/types/conversation.ts:70` — role: z.string().default('user'),

Suggestion: Before implementation, re-confirm the exact line numbers for conversation.ts /turn and /stream role handling at the pinned commit. Stale line references cause merge conflicts or missed edit sites.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
