# Tasks — operator-chat-service-token
Authoritative plan: `plan.md`. Lane `operator-chat-service-token` in `exafyltd/vitana-platform`. Branch
`kiro/operator-chat-service-token/operator-chat-service-token`; PR title
`VTID-xxxxx (operator-chat-service-token/operator-chat-service-token): …`; trailers `Collab-Session` and
`Collab-Lane: operator-chat-service-token/operator-chat-service-token`; identity `kiro-agent[bot]`; evidence in
`docs/validation/<VTID>/`. Paths below are under `services/gateway/` unless they start with `docs/`.

<!-- lane: operator-chat-service-token -->
## Group `operator-chat-service-token`
- [ ] O1 Write `test/operator-chat-service-token.test.ts` first, with the one case described in plan.md section 5. Run it
      against the unchanged `origin/main` code and save the red output as `docs/validation/<VTID>/outputs/red-on-base.txt`.
      It must fail on the header assertion, not on an import or setup error.
- [ ] O2 In `src/services/gemini-operator.ts`, replace the `apikey` and `Authorization` headers of
      `executeDevApproveItem` (:5686) and `executeDevRejectItem` (:5723) with `...gatewayServiceAuthHeader()`, as the
      VTID-05048 call at :5608 does. Add the VTID comment. Change nothing else in the file.
- [ ] O3 Run `npx jest test/operator-chat-service-token.test.ts` (green), `npm run test:operator`, `npm run test:roles`,
      `npm run typecheck`, and the suites that import `services/gemini-operator` (25 on base, plus the new test). Save the
      outputs under `docs/validation/<VTID>/outputs/`.
- [ ] O4 Write `docs/validation/<VTID>/acceptance.md`, `commands.log`, `scope.json` and `staging-tests.json` (an empty
      list, with the reason from plan.md section 9).

**Acceptance**
- Change types: Backend
- Outcome: Operator Chat approve and reject (the `dev_approve_item` and `dev_reject_item` tools) approve or reject the
  same approval and show the same reply. The only difference is the credential sent to the approvals route.
- States: no `GATEWAY_SERVICE_TOKEN` in the runtime, so the call sends no bearer. Once a gate exists, the route answers
  401 and nothing is approved. The failure is loud. On base there is no gate, so the call still works.
- Surfaces: the Operator Chat console and its developer tools. No screen, route or component changes.
- Locales: n/a: no user-visible text changes; the tool result messages stay as they are.
- Accessibility: n/a: no UI.
- Contract: `src/services/gemini-operator.ts:5692` and `:5729` send `POST /api/v1/approvals/:id/approve` and `/reject`
  to `localhost:${PORT}`. Request after the change: `Content-Type: application/json` and
  `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>`, with no `apikey`. Route side, when the gate lands:
  `src/middleware/require-service-or-admin.ts:71` answers 401 `missing bearer token` without a bearer, and 403 for a
  non-admin JWT. This lane changes no route handler and no route response.
- Staging proof: not verified on staging: the change alters the headers of two in-process calls, and a real approve or
  reject writes to the shared Supabase project. Staging suites are read-only (CLAUDE.md rule 48). Covered by
  `test/operator-chat-service-token.test.ts`.
- Test: `test/operator-chat-service-token.test.ts` is red on origin/main for the header assertion and green after O2.
- Only the lane `paths` change. No approvals route, gate, middleware or other header in `gemini-operator.ts` changes.
- Ordering: merges to `main` before `approvals-auth-v2` (VTID-05528) and before `approvals-auth` (PR #4606).
