# Tasks — mt-track-s-authz
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Both lanes in `exafyltd/vitana-platform`. Branch
`kiro/mt-track-s-authz/<lane>`; PR title `VTID-xxxxx (mt-track-s-authz/<lane>): …`; trailers `Collab-Session` +
`Collab-Lane: mt-track-s-authz/<lane>`; identity `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`. Paths below
are under `services/gateway/` unless they start with `docs/`.

<!-- lane: approvals-auth -->
## Lane `approvals-auth`
- [ ] A1 Re-check plan §2 at the lane base: `routes/approvals.ts` POST routes still have no auth middleware and
      `index.ts:819` still mounts the router bare. A change → re-read and adapt within the lane `paths`, log it.
- [ ] A2 Write `test/mt-track-s-authz-approvals-auth.test.ts` first and record it red on `origin/main`: 401 without a
      bearer and 403 with a non-exafy JWT on `POST /feed/approve`, `POST /:approval_id/approve`,
      `POST /:approval_id/reject`; the service token and an exafy_admin JWT reach the handler (outbound `fetch` mocked,
      nothing merged); `/feed/approve` answers 400 `branch_mismatch` when `branch` is not the feed item's `branch`.
- [ ] A3 `routes/approvals.ts`: `requireServiceOrAdmin` on the three POST routes; the `branch_mismatch` check in
      `/feed/approve`. GET routes unchanged.
- [ ] A4 `services/orb-tools/developer-tools.ts`: `approvalsApi` sends `Authorization: Bearer <id.user_jwt>` when
      present; `dev_approve_pr` / `dev_reject_pr` without `user_jwt` answer the admin-session message and make no
      call. Cases for both in the new test.
- [ ] A5 `routes/orb-live.ts` generic fallback identity (`:7019-7030`) and `routes/orb-tool.ts` identity (`:81-86`)
      carry `user_jwt`; at most 3 lines each.
- [ ] A6 Run `npx jest test/mt-track-s-authz-approvals-auth.test.ts test/vtid-05047-cicd-routes-auth.test.ts`,
      `npm run test:operator`, `npm run test:roles`, `npx tsc --noEmit`; record outputs in `docs/validation/<VTID>/`.
- [ ] A7 `docs/validation/<VTID>/staging-tests.json`: the two read-only 401 probes of plan §6.

**Acceptance**
- Change types: Backend.
- Outcome: only the gateway itself (service token) or an exafy_admin can approve, reject or feed-approve a change
  through `/api/v1/approvals`; anyone else gets 401/403 and nothing is merged. A feed approval merges only the PR whose
  CI was checked. A developer approving by voice keeps working with their own signed-in session.
- States: no bearer → 401 `missing bearer token`; non-exafy JWT → 403; branch mismatch → 400 `branch_mismatch`;
  voice session without a token → the admin-session answer, no call.
- Surfaces: callers — developer voice tools (Vertex/Nova path and LiveKit `/orb/tool`); no Command Hub screen calls
  the POST routes (`app.js:5272` reads `GET /feed`, `operator-console.js:3116`, `:3702` read `GET /pending`, both
  unchanged).
- Locales: n/a: no user-visible catalog text changes; the voice answer is the existing admin-session text.
- Accessibility: n/a: no UI.
- Contract: `requireServiceOrAdmin` (`middleware/require-service-or-admin.ts:71`) → 401/403 JSON `{ ok:false, error }`;
  handlers unchanged after the gate; the tools send `Authorization: Bearer <user_jwt>`
  (`developer-tools.ts:109-132` ↔ `approvals.ts:529`, `:651`, `:780`).
- Staging proof: `POST /api/v1/approvals/appr_invalid/approve` and `POST /api/v1/approvals/feed/approve` (`{}`), no
  bearer, expect 401 `application/json`. Both answer 400 at input validation on base, so the probes write nothing.
- Only the lane `paths` change; `gatewayApiCall`, the GET routes and `test/vtid-05047-cicd-routes-auth.test.ts` are
  unchanged and green.

<!-- lane: work-surface-permission -->
## Lane `work-surface-permission`
- [ ] W1 Re-check plan §2 at the lane base (profile resolution at `live-session-controller.ts:1181-1187`, the
      LiveKit mint at `orb-livekit.ts:690-697`, the text role at `conversation.ts:216`, `:918`).
- [ ] W2 Write `test/mt-track-s-authz-work-surface.test.ts` first and record it red on `origin/main`: the
      `verifyWorkSurfaceProfile` matrix (`command-hub`, `admin`, `backoffice`, `commerce` × exafy_admin, permitted,
      not permitted, `permittedRoles: null`); a controller case where a caller without a permitted role declares
      `command-hub` or `admin` and gets the member surface with no admin briefing; a LiveKit mint case; a text-path
      case where body role `developer` without permission yields the `'user'` tool set.
- [ ] W3 `orb/profile/assistant-profile.ts`: add `verifyWorkSurfaceProfile` per plan §4 (pure; `resolveAssistantProfile`
      unchanged).
- [ ] W4 `orb/live/session/live-session-controller.ts`: read `fetchPermittedRoles` for an authenticated work-surface
      session (not for exafy_admin) and apply W3 before any consumer reads the profile; at most 20 lines.
- [ ] W5 `routes/orb-livekit.ts`: the same check on the mint's profile.
- [ ] W6 `routes/conversation.ts`: clamp the body role on `/turn` and `/stream` per plan §4; the
      `developer_assistant` check unchanged.
- [ ] W7 Run the new test, `npm run test:roles`, `npm run test:support`, `npm run test:operator`,
      `npm run test:voice-identity`, `npx tsc --noEmit`; record outputs in `docs/validation/<VTID>/`. The PR states the
      deliberate contract change (rule 42h): a Command Hub, admin or backoffice declaration without a permitted role is
      served the member surface.
- [ ] W8 `docs/validation/<VTID>/staging-tests.json` with an `existing` reference to the Jest suites (plan §6).

**Acceptance**
- Change types: Backend.
- Outcome: Vitana serves the developer, admin or BackOffice assistant only to a caller who is allowed to open those
  screens; anyone else talks to the member Vitana, without admin briefing and without privileged tools. The text chat
  uses a privileged role only when the caller holds it.
- States: exafy_admin → declared surface kept; permitted role → kept; not permitted → member surface (`narrowed`);
  permitted roles unreadable → member surface (fail closed); anonymous → unchanged (`anonymous`).
- Surfaces: callers — Vertex/Nova voice session start (WS and SSE), LiveKit token mint, `/conversation/turn` and
  `/conversation/stream`; the member surface and the Command Hub for exafy_admin are unchanged.
- Locales: n/a: no user-visible catalog text; spoken wording stays model-composed (NEVER 41).
- Accessibility: n/a: no UI.
- Contract: `verifyWorkSurfaceProfile(profile, { isExafyAdmin, permittedRoles }) → AssistantProfile`;
  `fetchPermittedRoles` (`lib/permitted-roles.ts:36`) read-only; `orb.session.profile.resolved` reports the final
  `resolution`; conversation responses keep their shape.
- Staging proof: not verified on staging: an authenticated ORB session start writes session rows to the shared
  database (CLAUDE.md rule 48); the Jest suites prove it and are referenced as `existing`.
- `npm run test:roles` stays green without editing `test/vtid-04560-role-separation-regression.test.ts` (`:108-110`
  tests the unchanged pure resolver; `:848-851` builds an already-verified profile). No assertion is loosened.
